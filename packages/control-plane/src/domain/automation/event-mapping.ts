/**
 * Events → Pipelines — the reason this module changes when a new GitHub
 * event must map to a trigger or a cancellation. Holds the dispatch switch,
 * the push/PR/delete handlers, and branch cancellation (PR closed / branch
 * deleted). Depends only on the trigger core and the definition cache.
 */
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { anyGlobMatches, type Id, type Pipeline } from "@factory/shared";
import type { Database } from "../../db/client.js";
import { pipelineDefinitionCache, projects, repositories, runs, stepRuns, webhookDeliveries } from "../../db/schema.js";
import type { AutomationDeps } from "./deps.js";
import type { RepoRef } from "../git-host.js";
import { recordAuditEvent } from "../audit.js";
import { advanceGraph, finalizeRunIfDone, parsePipelineSnapshot } from "../graph-advance.js";
import { fillCacheFromPush, readAndValidateAt } from "./definition-cache.js";
import { findAutomationServiceAccount, triggerAutomationRun } from "./trigger.js";

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

/** `on: { push: ... }` matches the event iff branches and paths filters pass (repos is the cross-repo half — evaluated by the caller). */
function pushFilterMatches(on: Pipeline["on"], branch: string, changedPaths: string[]): boolean {
  const push = on?.push;
  if (push === undefined) return false;
  if (push.branches !== undefined && !anyGlobMatches(push.branches, branch)) return false;
  if (push.paths !== undefined && !changedPaths.some((path) => anyGlobMatches(push.paths!, path))) return false;
  return true;
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

/** The one dispatch switch: event type to handler. Unknown event types are ack'ed and forgotten. */
export async function dispatchWebhookEvent(
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
