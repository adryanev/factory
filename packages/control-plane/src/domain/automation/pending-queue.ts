/**
 * The `pending_automation_runs` drain — the reason this module changes when
 * `concurrency: queue` semantics change. Turns depth-1 snapshots into Runs
 * once their (Pipeline, ref) key frees up, using only the snapshot — a drain
 * never re-reads a ref that moved.
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import { pendingAutomationRuns, projects, repositories, runs } from "../../db/schema.js";
import type { AutomationDeps } from "./deps.js";
import { recordAuditEvent } from "../audit.js";
import { parsePipelineSnapshot } from "../graph-advance.js";
import { materializeRun } from "../runs.js";
import { isUniqueViolation } from "./trigger.js";

/** Drains `concurrency: queue` snapshots whose (Pipeline, ref) key has no active Run anymore. */
export async function sweepPendingAutomationRuns(deps: AutomationDeps): Promise<number> {
  let drained = 0;
  for (;;) {
    const outcome = await deps.db.transaction(async (tx) => {
      const [pending] = await tx
        .select()
        .from(pendingAutomationRuns)
        .orderBy(asc(pendingAutomationRuns.createdAt))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!pending) return "empty" as const;

      const [project] = await tx.select().from(projects).where(eq(projects.id, pending.projectId));
      const [repository] = await tx
        .select()
        .from(repositories)
        .where(eq(repositories.id, pending.pipelineRepositoryId));
      if (!project || !repository) {
        await tx.delete(pendingAutomationRuns).where(eq(pendingAutomationRuns.id, pending.id));
        return "dropped" as const;
      }
      const [active] = await tx
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            eq(runs.projectId, pending.projectId),
            eq(runs.triggerKind, "automation"),
            eq(runs.pipelineRepositoryId, pending.pipelineRepositoryId),
            eq(runs.pipelinePath, pending.pipelinePath),
            eq(runs.refBranch, pending.refBranch),
            isNull(runs.endedAt),
          ),
        )
        .limit(1);
      if (active) return "busy" as const; // still running — leave the snapshot queued.

      const pipeline = parsePipelineSnapshot(pending.definition);
      if (pipeline === null) {
        await tx.delete(pendingAutomationRuns).where(eq(pendingAutomationRuns.id, pending.id));
        return "dropped" as const; // a snapshot that cannot parse was never triggerable.
      }
      try {
        await materializeRun(deps, tx, {
          id: pending.id,
          project,
          pipelineRepository: repository,
          pipelinePath: pending.pipelinePath,
          refBranch: pending.refBranch,
          refSha: pending.refSha,
          triggerKind: "automation",
          triggeredByPrincipalId: pending.serviceAccountPrincipalId,
          credentialPrincipalId: pending.serviceAccountPrincipalId,
          definitionText: pending.definition as string,
          pipeline,
          definitionFiles: pending.definitionFiles as Record<string, string>,
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          // Layer-2 dedup: a Run for this (Pipeline, SHA) already exists —
          // the event is fully consumed either way.
          await tx.delete(pendingAutomationRuns).where(eq(pendingAutomationRuns.id, pending.id));
          return "deduped" as const;
        }
        throw error;
      }
      await tx.delete(pendingAutomationRuns).where(eq(pendingAutomationRuns.id, pending.id));
      await recordAuditEvent({ db: tx }, {
        actor: { kind: "service_account", id: pending.serviceAccountPrincipalId },
        projectId: pending.projectId,
        action: "run.triggered",
        targetType: "run",
        targetId: pending.id,
        metadata: { pipelinePath: pending.pipelinePath, refBranch: pending.refBranch, refSha: pending.refSha, automation: true, queued: true },
      });
      return "drained" as const;
    });
    if (outcome === "empty") break;
    if (outcome === "busy") break; // the key is still held — re-check on a later sweep, not in a hot loop.
    drained += 1;
  }
  return drained;
}
