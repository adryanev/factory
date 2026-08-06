/**
 * Automation: how Runs are triggered without a human (spec: "Automation",
 * CONTEXT.md: "Automation", ticket 22). One GitHub App webhook feeds this
 * module — a single endpoint verifies the HMAC, drops the raw event into
 * `webhook_deliveries`, and answers 2xx; every bit of mapping happens here,
 * out of GitHub's request path, on the same sweep cadence the lease and
 * notification sweeps already ride.
 *
 * The invariants this issue exists to establish:
 *
 *  - **`on:` maps two sets.** A push to repo X triggers (a) Pipelines whose
 *    host Repository is X — their definitions are read from the pushed ref —
 *    and (b) cross-repo Pipelines in the Project's other Repositories that
 *    write `on: { push: { repos: [X] } }` — their definitions are read from
 *    the default branch of the Repository that hosts them, because the
 *    pushed ref does not exist there (ticket 22, "Pemetaan kejadian →
 *    Pipeline").
 *  - **The definition cache is mandatory for discovery, never read on the
 *    execution path.** Finding "which (Repository, path) pairs are
 *    Pipelines" has no other path than `pipeline_definition_cache` — that is
 *    what makes the cache mandatory rather than an optimization. Every
 *    trigger still reads the definition **fresh from the ref** (or from the
 *    queue snapshot) and validates it; the cache's `parsed` column is
 *    bookkeeping, and `runs.definition` is the only thing execution reads.
 *    The cache is filled synchronously on miss: a push's changed paths are
 *    read and validated right there in the event handler.
 *  - **Fork PRs are ignored entirely** — the definition would be read from
 *    the fork's head, which is text anyone can write (CVE-2025-66032's class
 *    of attack). One line closes it: head repo ≠ base repo ⇒ drop.
 *  - **Dedup has two layers.** `webhook_deliveries.delivery_id` is layer 1
 *    (primary key, GitHub's own redeliveries land on `ON CONFLICT DO
 *    NOTHING`, pruned after 24h). Layer 2 is the partial unique index
 *    `runs_pipeline_sha_automation_dedup` — one automation Run per
 *    (Pipeline, SHA), enforced by Postgres, so a push and a PR synchronize
 *    for the same SHA produce one Run, and two control planes racing end in
 *    a constraint violation, not a duplicate Run.
 *  - **Concurrency default is `cancel`** — a new push for (Pipeline, ref)
 *    cancels the active automation Run for the same key before inserting its
 *    own, all in one transaction. `concurrency: queue` instead snapshots the
 *    event into `pending_automation_runs` (depth 1: the third event replaces
 *    the second) and the sweep drains it when the key frees up. Cron never
 *    queues — it skips.
 *  - **Schedule is read from the default branch** — a schedule merged to the
 *    default branch lives only after the merge, and a PR cannot schedule
 *    anything. Overlap (an active Run for the same (Pipeline, ref)) is
 *    skipped, and the skip is recorded in `cron_skips`, visible through the
 *    runs surface. Same-SHA overlap is not a skip — it is the layer-2 dedup,
 *    which stays silent.
 *  - **Branch deleted / PR closed cancels**, including `awaiting-human`
 *    StepRuns: the human declared the work irrelevant, and a Question from a
 *    cancelled Run must vanish with it (issue #14's escape hatch). Manual
 *    Runs are untouched — they have no git-event ref.
 *  - **No comment trigger is built.** A comment carries no session, and the
 *    only identity available would be GitHub's, which this codebase forbids
 *    for authorization. The manual trigger stays the UI button.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lt, lte, ne } from "drizzle-orm";
import {
  anyGlobMatches,
  cronMatches,
  generateId,
  validatePipelineDefinition,
  type Id,
  type Pipeline,
} from "@factory/shared";
import type { Database } from "../db/client.js";
import {
  cronSkips,
  pendingAutomationRuns,
  pipelineDefinitionCache,
  projects,
  repositories,
  runs,
  serviceAccounts,
  stepRuns,
  webhookDeliveries,
} from "../db/schema.js";
import type { AppDeps, Clock } from "../deps.js";
import type { Principal } from "./principal.js";
import { recordAuditEvent } from "./audit.js";
import { DomainValidationError, UnauthorizedError } from "./errors.js";
import type { GitHost, RepoRef } from "./git-host.js";
import { advanceGraph, finalizeRunIfDone, parsePipelineSnapshot } from "./graph-advance.js";
import { materializeRun, readPromptFiles, type MaterializeRunInput } from "./runs.js";
import { requireProjectMembership } from "./projects.js";

/** The world this module reaches into — a strict subset of `AppDeps`. */
export type AutomationDeps = Pick<AppDeps, "db" | "clock" | "gitHost">;

/** The sweep needs one more piece of per-process state: the schedule watermark. */
export type AutomationSweepDeps = AutomationDeps & { scheduleWatermark: { minute: string | null } };

/** The webhook secret lives in deps, so it can never reach a route (see `domain/index.ts`). */
export interface WebhookIngestInput {
  rawBody: string;
  signature: string | null;
  eventType: string | null;
  deliveryId: string | null;
}

export interface WebhookIngestResult {
  deliveryId: string;
  /** False for a redelivered `X-GitHub-Delivery` already on file — the event is dropped by the primary key. */
  accepted: boolean;
}

/** Constant-time HMAC check of `x-hub-signature-256`. Pure — exported for the contract test. */
export function verifyWebhookSignature(secret: string, rawBody: string, signature: string | null): boolean {
  if (signature === null) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody, "utf-8").digest("hex")}`;
  const actual = Buffer.from(signature, "utf-8");
  const want = Buffer.from(expected, "utf-8");
  return actual.length === want.length && timingSafeEqual(actual, want);
}

/**
 * The webhook endpoint's whole job: verify the HMAC, then drop the raw
 * event into `webhook_deliveries` (`X-GitHub-Delivery` as primary key —
 * layer-1 dedup) and let the sweep do the mapping. Throws `UnauthorizedError`
 * on a bad signature, `DomainValidationError` on an undeliverable body; the
 * route maps those to 401/400 and answers 202 on success.
 */
export async function ingestWebhook(
  deps: AutomationDeps & { githubWebhookSecret: string },
  input: WebhookIngestInput,
): Promise<WebhookIngestResult> {
  if (input.deliveryId === null || input.deliveryId === "") {
    throw new DomainValidationError("webhook_delivery_id_missing", "the X-GitHub-Delivery header is required");
  }
  if (!verifyWebhookSignature(deps.githubWebhookSecret, input.rawBody, input.signature)) {
    throw new UnauthorizedError("invalid GitHub webhook signature");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(input.rawBody) as unknown;
  } catch {
    throw new DomainValidationError("webhook_body_invalid", "the webhook body is not valid JSON");
  }

  const inserted = await deps.db
    .insert(webhookDeliveries)
    .values({
      deliveryId: input.deliveryId,
      eventType: input.eventType ?? "unknown",
      payload,
      // Stamped from the same clock the sweep compares against (deps.clock),
      // not the column's DB-side `now()` default — the sweep's `nextAttemptAt
      // <= now` gate must never reject a row this instant just inserted
      // because the app clock and the database server's clock disagree.
      nextAttemptAt: deps.clock.now(),
    })
    .onConflictDoNothing()
    .returning({ deliveryId: webhookDeliveries.deliveryId });
  return { deliveryId: input.deliveryId, accepted: inserted.length > 0 };
}

/** A pipeline definition read fresh from a ref and validated. */
interface ReadDefinition {
  text: string;
  pipeline: Pipeline;
}

/** Reads and validates a definition file at an exact sha. `null` = missing or invalid — both mean "not a triggerable Pipeline". */
async function readAndValidateAt(
  gitHost: GitHost,
  repo: RepoRef,
  sha: string,
  path: string,
): Promise<ReadDefinition | null> {
  const text = await gitHost.readFile(repo, sha, path);
  if (text === null) return null;
  const validation = validatePipelineDefinition(text);
  if (!validation.valid) return null;
  return { text, pipeline: validation.pipeline };
}

/** The Project's ServiceAccount, deterministic — first by principal id. Null when the Project has none; automation cannot run without one (CONTEXT.md: Automation berjalan sebagai ServiceAccount milik Project-nya). */
async function findAutomationServiceAccount(
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

/** Resolves the event's `repository.full_name` ("owner/name") to a Repository row. */
async function findRepositoryByFullName(
  db: Database,
  fullName: string,
): Promise<typeof repositories.$inferSelect | null> {
  const [owner, name] = fullName.split("/");
  if (!owner || !name) return null;
  const [row] = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.owner, owner), eq(repositories.name, name)));
  return row ?? null;
}

interface PushPayload {
  ref: string;
  after: string;
  deleted?: boolean;
  commits?: { added?: string[]; removed?: string[]; modified?: string[] }[];
  repository?: { full_name?: string };
}

function pushChangedPaths(payload: PushPayload): { changed: string[]; removed: string[] } {
  const changed = new Set<string>();
  const removed = new Set<string>();
  for (const commit of payload.commits ?? []) {
    for (const path of commit.added ?? []) changed.add(path);
    for (const path of commit.modified ?? []) changed.add(path);
    for (const path of commit.removed ?? []) {
      changed.add(path);
      removed.add(path);
    }
  }
  return { changed: [...changed], removed: [...removed] };
}

/**
 * Fill-on-miss, synchronously: every path a push touched is read at the
 * pushed sha and upserted into `pipeline_definition_cache` when it validates
 * as a Pipeline. Removed paths drop their cache row — a deleted Pipeline
 * must stop discovering itself. This is the only refill the cache has, and
 * it is exactly what makes the "cache boleh dihapus kapan saja" claim honest:
 * the next event rebuilds it.
 */
async function fillCacheFromPush(
  deps: AutomationDeps,
  repository: typeof repositories.$inferSelect,
  repoRef: RepoRef,
  branch: string,
  sha: string,
  changedPaths: string[],
  removedPaths: string[],
): Promise<void> {
  const now = deps.clock.now();
  for (const path of changedPaths) {
    if (removedPaths.includes(path)) {
      await deps.db
        .delete(pipelineDefinitionCache)
        .where(and(eq(pipelineDefinitionCache.repositoryId, repository.id), eq(pipelineDefinitionCache.path, path)));
      continue;
    }
    const definition = await readAndValidateAt(deps.gitHost, repoRef, sha, path);
    if (definition === null) continue; // not a Pipeline — the cache indexes Pipelines only.
    await deps.db
      .insert(pipelineDefinitionCache)
      .values({
        repositoryId: repository.id,
        path,
        ref: branch,
        contentSha: sha,
        parsed: definition.pipeline,
        fetchedAt: now,
      })
      .onConflictDoUpdate({
        target: [pipelineDefinitionCache.repositoryId, pipelineDefinitionCache.path],
        set: { ref: branch, contentSha: sha, parsed: definition.pipeline, fetchedAt: now },
      });
  }
}

/** `on: { push: ... }` matches the event iff branches and paths filters pass (repos is the cross-repo half — evaluated by the caller). */
function pushFilterMatches(on: Pipeline["on"], branch: string, changedPaths: string[]): boolean {
  const push = on?.push;
  if (push === undefined) return false;
  if (push.branches !== undefined && !anyGlobMatches(push.branches, branch)) return false;
  if (push.paths !== undefined && !changedPaths.some((path) => anyGlobMatches(push.paths!, path))) return false;
  return true;
}

/**
 * The heart of the trigger: dedup (layer 2), concurrency, and the Run's
 * birth — one transaction, so "cancel the old Run and birth the new one"
 * commits atomically and a dedup conflict rolls the whole thing back (a
 * same-SHA redelivery must not cancel the Run it would have been a duplicate
 * of). Returns what happened, for the audit line and for tests.
 */
export type TriggerOutcome = "triggered" | "deduped" | "queued" | "skipped";

async function triggerAutomationRun(
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

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "23505"
  );
}

/** The push event: fill the cache, then trigger the host set and the cross-repo set. */
async function handlePushEvent(deps: AutomationDeps, raw: unknown): Promise<void> {
  const payload = raw as PushPayload;
  if (payload.deleted === true || /^0+$/.test(payload.after ?? "")) return; // branch deletion arrives as a `delete` event.
  if (typeof payload.ref !== "string" || !payload.ref.startsWith("refs/heads/")) return;
  const branch = payload.ref.slice("refs/heads/".length);
  const sha = payload.after;
  const repository = await findRepositoryByFullName(deps.db, payload.repository?.full_name ?? "");
  if (repository === null) return; // not a Repository of any Project — nothing to do.
  const [project] = await deps.db.select().from(projects).where(eq(projects.id, repository.projectId));
  if (project === undefined || !project.automationEnabled) return;
  const repoRef: RepoRef = { owner: repository.owner, name: repository.name };
  const { changed, removed } = pushChangedPaths(payload);
  await fillCacheFromPush(deps, repository, repoRef, branch, sha, changed, removed);

  // Set 1 — Pipelines hosted by the pushed Repository: definition read from
  // the pushed ref itself.
  const hostCandidates = await deps.db
    .select()
    .from(pipelineDefinitionCache)
    .where(eq(pipelineDefinitionCache.repositoryId, repository.id));
  for (const candidate of hostCandidates) {
    const definition = await readAndValidateAt(deps.gitHost, repoRef, sha, candidate.path);
    if (definition === null) continue;
    if (!pushFilterMatches(definition.pipeline.on, branch, changed)) continue;
    await triggerAutomationRun(deps, project, repository, candidate.path, definition, branch, sha);
  }

  // Set 2 — cross-repo Pipelines in the Project's other Repositories
  // (`on: { push: { repos: [<this repo's name>] } }`): definition read from
  // each host Repository's default branch, because the pushed ref does not
  // exist there.
  const crossCandidates = await deps.db
    .select({ cache: pipelineDefinitionCache, repository: repositories })
    .from(pipelineDefinitionCache)
    .innerJoin(repositories, eq(repositories.id, pipelineDefinitionCache.repositoryId))
    .where(
      and(
        eq(repositories.projectId, project.id),
        ne(pipelineDefinitionCache.repositoryId, repository.id),
      ),
    );
  for (const candidate of crossCandidates) {
    const configRepo = candidate.repository;
    const configRef: RepoRef = { owner: configRepo.owner, name: configRepo.name };
    let defaultSha: string;
    try {
      defaultSha = await deps.gitHost.resolveRef(configRef, configRepo.defaultBranch);
    } catch {
      continue; // default branch gone — nothing to read.
    }
    const definition = await readAndValidateAt(deps.gitHost, configRef, defaultSha, candidate.cache.path);
    if (definition === null) continue;
    const on = definition.pipeline.on;
    if (!on?.push?.repos?.includes(repository.name)) continue;
    if (on.push.branches !== undefined && !anyGlobMatches(on.push.branches, branch)) continue;
    await triggerAutomationRun(deps, project, configRepo, candidate.cache.path, definition, branch, sha);
  }
}

interface PullRequestPayload {
  action?: string;
  repository?: { full_name?: string };
  pull_request?: {
    head?: { ref?: string; sha?: string; repo?: { full_name?: string } };
    base?: { repo?: { full_name?: string } };
  };
}

/** An open/synchronize/reopened PR event: head-SHA definition, fork PRs dropped. */
async function handlePullRequestEvent(deps: AutomationDeps, raw: unknown): Promise<void> {
  const payload = raw as PullRequestPayload;
  const head = payload.pull_request?.head;
  const base = payload.pull_request?.base;
  const headRef = head?.ref;
  const headSha = head?.sha;
  const headRepoFullName = head?.repo?.full_name;
  const baseRepoFullName = base?.repo?.full_name;
  if (!headRef || !headSha || !headRepoFullName || !baseRepoFullName) return;
  // Fork PRs are ignored entirely: the definition is read from the head, and
  // the head of a fork is text anyone can write (ticket 22).
  if (headRepoFullName !== baseRepoFullName) return;

  const repository = await findRepositoryByFullName(deps.db, baseRepoFullName);
  if (repository === null) return;
  const [project] = await deps.db.select().from(projects).where(eq(projects.id, repository.projectId));
  if (project === undefined || !project.automationEnabled) return;
  const repoRef: RepoRef = { owner: repository.owner, name: repository.name };

  const candidates = await deps.db
    .select()
    .from(pipelineDefinitionCache)
    .where(eq(pipelineDefinitionCache.repositoryId, repository.id));
  for (const candidate of candidates) {
    const definition = await readAndValidateAt(deps.gitHost, repoRef, headSha, candidate.path);
    if (definition === null) continue;
    if (definition.pipeline.on?.pullRequest !== true) continue;
    await triggerAutomationRun(deps, project, repository, candidate.path, definition, headRef, headSha);
  }
}

/** PR closed / branch deleted: the human declared the work irrelevant — cancel, including `awaiting-human`. */
async function cancelAutomationRunsForBranch(deps: AutomationDeps, projectId: Id<"project">, refBranch: string): Promise<number> {
  const targets = await deps.db
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.projectId, projectId),
        eq(runs.triggerKind, "automation"),
        eq(runs.refBranch, refBranch),
        isNull(runs.endedAt),
        isNull(runs.cancelRequestedAt),
      ),
    );
  for (const run of targets) {
    await cancelAutomationRun(deps, run);
  }
  return targets.length;
}

/**
 * One Run's full cancellation: intent (`cancel_requested_at`) plus every
 * non-terminal StepRun — `ready`, `running`, and crucially `awaiting-human` —
 * goes `cancelled` in the same transaction as the Graph advance and the
 * Run-finalizing verdict, so a Question from a cancelled Run vanishes from
 * the badge (which reads `outcome = 'awaiting-human'`) at once. Running
 * StepRuns are fenced by the heartbeat's `cancel` list. Manual Runs are
 * never touched — this is called only for `trigger_kind = 'automation'`.
 */
export async function cancelAutomationRun(
  deps: AutomationDeps,
  run: typeof runs.$inferSelect,
): Promise<void> {
  const now = deps.clock.now();
  await deps.db.transaction(async (tx) => {
    await tx
      .update(runs)
      .set({ cancelRequestedAt: now })
      .where(and(eq(runs.id, run.id), isNull(runs.cancelRequestedAt)));

    const NON_TERMINAL: Array<"ready" | "running" | "awaiting-human"> = ["ready", "running", "awaiting-human"];
    const rows = await tx
      .select()
      .from(stepRuns)
      .where(and(eq(stepRuns.runId, run.id), inArray(stepRuns.outcome, NON_TERMINAL)));
    const cancelledKeys = new Set<string>();
    for (const row of rows) {
      await tx
        .update(stepRuns)
        .set({ outcome: "cancelled", reason: "cancelled-by-automation" })
        .where(eq(stepRuns.id, row.id));
      cancelledKeys.add(row.stepKey);
    }
    const pipeline = parsePipelineSnapshot(run.definition);
    if (pipeline) {
      for (const key of cancelledKeys) {
        await advanceGraph({ db: tx, now: () => now }, run, pipeline, key);
      }
      await finalizeRunIfDone({ db: tx, now: () => now }, run.id, pipeline);
    }
  });

  const serviceAccount = await findAutomationServiceAccount(deps.db, run.projectId);
  if (serviceAccount) {
    await recordAuditEvent(deps, {
      actor: { kind: "service_account", id: serviceAccount.principalId },
      projectId: run.projectId,
      action: "run.cancel_requested",
      targetType: "run",
      targetId: run.id,
      metadata: { source: "automation" },
    });
  }
}

/** The schedule sweep, gated to one evaluation per UTC minute per instance (a second evaluation in the same minute would re-read every scheduled definition for nothing — layer-2 dedup already makes it harmless, the watermark just keeps it cheap). */
const SCHEDULE_MINUTE_LENGTH = 16; // "2026-01-01T03:00" — toISOString() up to the minute.

export async function sweepSchedules(deps: AutomationSweepDeps): Promise<void> {
  const now = deps.clock.now();
  const minute = now.toISOString().slice(0, SCHEDULE_MINUTE_LENGTH);
  if (deps.scheduleWatermark.minute === minute) return;
  deps.scheduleWatermark.minute = minute;

  const rows = await deps.db
    .select({ project: projects, repository: repositories, cache: pipelineDefinitionCache })
    .from(pipelineDefinitionCache)
    .innerJoin(repositories, eq(repositories.id, pipelineDefinitionCache.repositoryId))
    .innerJoin(projects, eq(projects.id, repositories.projectId))
    .where(eq(projects.automationEnabled, true));

  for (const { project, repository, cache } of rows) {
    const repoRef: RepoRef = { owner: repository.owner, name: repository.name };
    let defaultSha: string;
    try {
      defaultSha = await deps.gitHost.resolveRef(repoRef, repository.defaultBranch);
    } catch {
      continue; // the default branch is gone — nothing to schedule from.
    }
    // The definition is read from the default branch — a schedule merged to
    // the default branch lives only after the merge (a PR cannot schedule).
    const definition = await readAndValidateAt(deps.gitHost, repoRef, defaultSha, cache.path);
    if (definition === null) continue;
    const schedule = definition.pipeline.on?.schedule;
    if (!schedule || !schedule.some((expression) => cronMatches(expression, now))) continue;

    const [active] = await deps.db
      .select({ refSha: runs.refSha })
      .from(runs)
      .where(
        and(
          eq(runs.projectId, project.id),
          eq(runs.triggerKind, "automation"),
          eq(runs.pipelineRepositoryId, repository.id),
          eq(runs.pipelinePath, cache.path),
          eq(runs.refBranch, repository.defaultBranch),
          isNull(runs.endedAt),
        ),
      )
      .limit(1);
    if (active) {
      // Same-SHA overlap is layer-2 dedup (silent — this minute's Run already
      // exists, possibly born by the other control-plane instance racing us).
      // A different-SHA active Run is a genuine overlap: skipped, visibly.
      if (active.refSha !== defaultSha) {
        await deps.db.insert(cronSkips).values({
          id: generateId("skip"),
          projectId: project.id,
          pipelineRepositoryId: repository.id,
          pipelinePath: cache.path,
          refBranch: repository.defaultBranch,
          refSha: defaultSha,
          scheduledFor: now,
          skippedAt: now,
          reason: "run-active",
        });
      }
      continue;
    }
    await triggerAutomationRun(deps, project, repository, cache.path, definition, repository.defaultBranch, defaultSha);
  }
}

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
          definitionFiles: pending.definitionFiles as unknown as Record<string, string>,
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

/** Dispatch attempts before a delivery is dead-lettered (marked processed without ever having succeeded) — the bound that keeps a permanently-failing delivery from looping the sweep forever. */
export const WEBHOOK_MAX_ATTEMPTS = 5;

const WEBHOOK_RETRY_BASE_MS = 30_000;
const WEBHOOK_RETRY_MAX_MS = 60 * 60 * 1000;

/**
 * The delay before a failed delivery may be selected again, given the
 * attempt count *after* the failure that just happened. Pure — provable
 * without a database or a clock, unlike the sweep itself. `attempts=1` (the
 * first failure) waits 30s; each further failure doubles the wait, capped at
 * an hour.
 */
export function webhookRetryBackoffMs(attempts: number): number {
  return Math.min(WEBHOOK_RETRY_BASE_MS * 2 ** (attempts - 1), WEBHOOK_RETRY_MAX_MS);
}

/**
 * Processes due webhook deliveries oldest-first: `processedAt IS NULL AND
 * nextAttemptAt <= now`, with `now` read once at the sweep's start (already
 * true before this comment existed). That single `now` is what bounds the
 * loop — a delivery a failure just rescheduled carries a `nextAttemptAt`
 * strictly after this sweep's `now`, so it drops out of the selection
 * predicate and cannot be re-selected until a later sweep. Without that, a
 * delivery that always fails would be re-selected on every loop iteration,
 * forever, inside this one sweep — moving the `update` after the `catch`
 * cannot fix that by itself, which is why the retry needs its own schedule
 * column rather than just staying unprocessed.
 *
 * A dispatch failure increments `attempts` and reschedules via
 * `webhookRetryBackoffMs`; at `WEBHOOK_MAX_ATTEMPTS` the row is
 * dead-lettered instead — marked `processedAt` so it stops being selected.
 *
 * The 24h window this used to hard-delete on is the retention sweep's job
 * now (`webhook_candidate`/`webhook_mark` in db/sql/retention_sweeps.sql,
 * driven by `runRetentionSweeps`): it marks `purgedAt` on its own hourly
 * cadence, independent of `processedAt`, and never removes the row.
 */
export async function sweepWebhookDeliveries(deps: AutomationDeps): Promise<number> {
  const now = deps.clock.now();

  let processed = 0;
  for (;;) {
    const [delivery] = await deps.db
      .select()
      .from(webhookDeliveries)
      .where(and(isNull(webhookDeliveries.processedAt), lte(webhookDeliveries.nextAttemptAt, now)))
      .orderBy(asc(webhookDeliveries.nextAttemptAt))
      .limit(1);
    if (!delivery) break;
    try {
      await dispatchWebhookEvent(deps, delivery);
      await deps.db
        .update(webhookDeliveries)
        .set({ processedAt: now })
        .where(eq(webhookDeliveries.deliveryId, delivery.deliveryId));
    } catch (error) {
      const attempts = delivery.attempts + 1;
      if (attempts >= WEBHOOK_MAX_ATTEMPTS) {
        // Dead-lettered, not an ordinary retry: the event is permanently
        // given up on, so it is marked processed (stops being selected)
        // without ever having dispatched successfully.
        console.error(
          `automation delivery ${delivery.deliveryId} (${delivery.eventType}) dead-lettered after ${attempts} attempts`,
          error,
        );
        await deps.db
          .update(webhookDeliveries)
          .set({ attempts, processedAt: now })
          .where(eq(webhookDeliveries.deliveryId, delivery.deliveryId));
      } else {
        console.error(`automation delivery ${delivery.deliveryId} (${delivery.eventType}) failed, retrying`, error);
        await deps.db
          .update(webhookDeliveries)
          .set({ attempts, nextAttemptAt: new Date(now.getTime() + webhookRetryBackoffMs(attempts)) })
          .where(eq(webhookDeliveries.deliveryId, delivery.deliveryId));
      }
    }
    processed += 1;
  }
  return processed;
}

/** The one dispatch switch: event type to handler. Unknown event types are ack'ed and forgotten. */
async function dispatchWebhookEvent(
  deps: AutomationDeps,
  delivery: typeof webhookDeliveries.$inferSelect,
): Promise<void> {
  const payload = delivery.payload as Record<string, unknown>;
  switch (delivery.eventType) {
    case "push":
      await handlePushEvent(deps, payload);
      return;
    case "pull_request": {
      const action = typeof payload["action"] === "string" ? payload["action"] : "";
      if (action === "closed") {
        await handlePullRequestClosed(deps, payload);
      } else if (action === "opened" || action === "synchronize" || action === "reopened") {
        await handlePullRequestEvent(deps, payload);
      }
      return;
    }
    case "delete":
      await handleDeleteEvent(deps, payload);
      return;
    default:
      return; // ping, issues, workflows, ... — nothing this system triggers on.
  }
}

async function handlePullRequestClosed(deps: AutomationDeps, raw: unknown): Promise<void> {
  const payload = raw as PullRequestPayload;
  const headRef = payload.pull_request?.head?.ref;
  const baseRepoFullName = payload.pull_request?.base?.repo?.full_name;
  if (!headRef || !baseRepoFullName) return;
  const repository = await findRepositoryByFullName(deps.db, baseRepoFullName);
  if (repository === null) return;
  await cancelAutomationRunsForBranch(deps, repository.projectId, headRef);
}

async function handleDeleteEvent(deps: AutomationDeps, raw: unknown): Promise<void> {
  const payload = raw as { ref?: string; ref_type?: string; repository?: { full_name?: string } };
  if (payload.ref_type !== "branch" || !payload.ref) return;
  const repository = await findRepositoryByFullName(deps.db, payload.repository?.full_name ?? "");
  if (repository === null) return;
  await cancelAutomationRunsForBranch(deps, repository.projectId, payload.ref);
}

/** The combined automation sweep — rides the same cadence as the lease sweep (boot + every executor cycle). */
export async function sweepAutomation(
  deps: AutomationSweepDeps,
): Promise<{ deliveries: number; drained: number }> {
  const deliveries = await sweepWebhookDeliveries(deps);
  const drained = await sweepPendingAutomationRuns(deps);
  await sweepSchedules(deps);
  return { deliveries, drained };
}

export interface CronSkipPage {
  skips: (typeof cronSkips.$inferSelect)[];
  nextCursor: string | null;
}

/** The "cron yang dilewati" surface — keyset on id DESC, newest first, same shape as the Run list. */
export async function listCronSkips(
  deps: Pick<AppDeps, "db">,
  principal: Principal,
  projectId: Id<"project">,
  cursor: string | null,
  limit: number,
): Promise<CronSkipPage> {
  await requireProjectMembership(deps, principal, projectId);
  const conditions = [eq(cronSkips.projectId, projectId)];
  if (cursor) conditions.push(lt(cronSkips.id, cursor as Id<"skip">));
  const rows = await deps.db
    .select()
    .from(cronSkips)
    .where(and(...conditions))
    .orderBy(desc(cronSkips.id))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return { skips: page, nextCursor: hasMore ? (page[page.length - 1]!.id as string) : null };
}
