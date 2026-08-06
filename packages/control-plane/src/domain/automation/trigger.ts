/**
 * The automation trigger core — the reason this module changes when Run
 * birth semantics change: layer-2 dedup, the `cancel`/`queue` concurrency
 * policies, the ServiceAccount contract. Shared by `event-mapping.ts`,
 * `scheduling.ts`, and the `pending-queue.ts` drain.
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import { generateId, type Id } from "@factory/shared";
import type { Database } from "../../db/client.js";
import { pendingAutomationRuns, projects, repositories, runs, serviceAccounts } from "../../db/schema.js";
import type { AutomationDeps } from "./deps.js";
import type { Principal } from "../principal.js";
import { recordAuditEvent } from "../audit.js";
import type { RepoRef } from "../git-host.js";
import { materializeRun, readPromptFiles, type MaterializeRunInput } from "../runs.js";
import type { ReadDefinition } from "./definition-cache.js";

/** The Project's ServiceAccount, deterministic — first by principal id. Null when the Project has none; automation cannot run without one (CONTEXT.md: Automation berjalan sebagai ServiceAccount milik Project-nya). */
export async function findAutomationServiceAccount(
  db: Database,
  projectId: Id<"project">,
): Promise<{ principalId: Id<"serviceaccount"> } | null> {
  const [row] = await db
    .select({ principalId: serviceAccounts.principalId })
    .from(serviceAccounts)
    .where(eq(serviceAccounts.projectId, projectId))
    .orderBy(asc(serviceAccounts.principalId))
    .limit(1);
  return row ?? null;
}

/**
 * The heart of the trigger: dedup (layer 2), concurrency, and the Run's
 * birth — one transaction, so "cancel the old Run and birth the new one"
 * commits atomically and a dedup conflict rolls the whole thing back (a
 * same-SHA redelivery must not cancel the Run it would have been a duplicate
 * of). Returns what happened, for the audit line and for tests.
 */
export type TriggerOutcome = "triggered" | "deduped" | "queued" | "skipped";

export async function triggerAutomationRun(
  deps: AutomationDeps,
  project: typeof projects.$inferSelect,
  pipelineRepository: typeof repositories.$inferSelect,
  pipelinePath: string,
  definition: ReadDefinition,
  refBranch: string,
  refSha: string,
): Promise<TriggerOutcome> {
  const serviceAccount = await findAutomationServiceAccount(deps.db, project.id);
  if (serviceAccount === null) {
    console.warn(
      `automation event for ${pipelineRepository.owner}/${pipelineRepository.name} ${pipelinePath} dropped: Project ${project.id} has no ServiceAccount to run it as`,
    );
    return "skipped";
  }
  const principal: Principal = { kind: "service_account", id: serviceAccount.principalId };
  const now = deps.clock.now();
  const concurrency = definition.pipeline.concurrency ?? "cancel";

  try {
    const outcome = await deps.db.transaction(async (tx) => {
      const active = await tx
        .select()
        .from(runs)
        .where(
          and(
            eq(runs.projectId, project.id),
            eq(runs.triggerKind, "automation"),
            eq(runs.pipelineRepositoryId, pipelineRepository.id),
            eq(runs.pipelinePath, pipelinePath),
            eq(runs.refBranch, refBranch),
            isNull(runs.endedAt),
          ),
        );
      if (active.some((run) => run.refSha === refSha)) {
        return { kind: "deduped" as const };
      }
      if (concurrency === "queue" && active.length > 0) {
        // Depth 1: the third event replaces the second. The snapshot is
        // taken now (definition + prompt files at the event ref) so a drain
        // never re-reads a ref that moved.
        const repoRef: RepoRef = { owner: pipelineRepository.owner, name: pipelineRepository.name };
        const definitionFiles = await readPromptFiles(
          deps,
          repoRef,
          refSha,
          refBranch,
          pipelineRepository,
          definition.text,
          definition.pipeline,
        );
        await tx
          .insert(pendingAutomationRuns)
          .values({
            id: generateId("run"),
            projectId: project.id,
            pipelineRepositoryId: pipelineRepository.id,
            pipelinePath,
            refBranch,
            refSha,
            definition: definition.text,
            definitionFiles,
            serviceAccountPrincipalId: serviceAccount.principalId,
            createdAt: now,
          })
          .onConflictDoUpdate({
            target: [
              pendingAutomationRuns.pipelineRepositoryId,
              pendingAutomationRuns.pipelinePath,
              pendingAutomationRuns.refBranch,
            ],
            set: {
              refSha,
              definition: definition.text,
              definitionFiles,
              serviceAccountPrincipalId: serviceAccount.principalId,
              createdAt: now,
            },
          });
        return { kind: "queued" as const };
      }
      if (concurrency === "cancel") {
        for (const run of active) {
          if (run.cancelRequestedAt === null) {
            await tx
              .update(runs)
              .set({ cancelRequestedAt: now })
              .where(and(eq(runs.id, run.id), isNull(runs.cancelRequestedAt)));
          }
        }
      }
      const materialized = await materializeRun(deps, tx, {
        id: generateId("run"),
        project,
        pipelineRepository,
        pipelinePath,
        refBranch,
        refSha,
        triggerKind: "automation",
        triggeredByPrincipalId: serviceAccount.principalId,
        credentialPrincipalId: serviceAccount.principalId,
        definitionText: definition.text,
        pipeline: definition.pipeline,
      });
      return { kind: "triggered" as const, runId: materialized.run.id };
    });

    if (outcome.kind === "triggered") {
      await recordAuditEvent(deps, {
        actor: principal,
        projectId: project.id,
        action: "run.triggered",
        targetType: "run",
        targetId: outcome.runId,
        metadata: { pipelinePath, refBranch, refSha, automation: true },
      });
    }
    return outcome.kind;
  } catch (error) {
    if (isUniqueViolation(error)) {
      return "deduped"; // the partial index won a race between two control planes — same Run, both winners.
    }
    console.error(`automation trigger failed for ${pipelinePath} @ ${refBranch} (${refSha})`, error);
    return "skipped";
  }
}

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "23505"
  );
}
