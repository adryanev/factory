/**
 * The advance mechanism issue #4 deliberately left unbuilt: "'Hilir
 * dijadwalkan' ... belum punya pemanggil sampai `/result` ada" (its own
 * module doc, and `.scratch/distributed-software-factory/acceptance-index.md`
 * under Issue 4, deviation 3). `/result` (`step-run-turn.ts`) is that
 * caller, and this file is what it calls the instant a StepRun succeeds.
 *
 * Shape chosen: **(a) materialize-on-demand**, not (b) "materialize every
 * non-fan-out Step up front + a computed readiness predicate in the claim
 * query." Reasoning, weighed against the three options the acceptance-index
 * lays out:
 *
 *  - (b) is the more spec-faithful reading ("'Hilir dijadwalkan' ...
 *    dihitung" — computed, not stored) but means rewriting
 *    `claim_step_run.sql`'s `WHERE` clause and extending its seven green
 *    contract tests to prove the new predicate under concurrency. That
 *    query is this system's hottest path and explicitly not this issue's to
 *    rewrite (binding instruction: "Use it. Do not write a second claim
 *    query").
 *  - (c) an eighth `outcome` value contradicts the seven-value CHECK this
 *    repo already ships two contract tests against.
 *  - (a) needs zero schema change, zero change to `claim_step_run.sql`, and
 *    reuses the exact "root Step" materialization shape issue #4 already
 *    wrote (`domain/runs.ts`'s `materializableRootStepIds` + its insert
 *    loop) — just re-triggered from the opposite end (a Step finishing)
 *    instead of a Run starting. This is the smaller, reversible move while
 *    there is no production data to migrate; (b) remains available later
 *    without (a) having painted anything into a corner — no stored state
 *    changes shape either way.
 *
 * Deliberately narrow, matching #4's own materialization boundary: fan-out
 * (`branches:`/`branchesFrom:`) is untouched here — only a completed
 * non-fan-out Step (`branchKey IS NULL`) can unblock a downstream Step, and
 * only a downstream Step that is itself not a fan-out source gets
 * materialized. Join semantics (`join: any` / `{ min: N }`), skip
 * propagation on failure, and fan-out are issue #11's, not built here.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { generateId, validatePipelineDefinition, type Id, type Pipeline } from "@factory/shared";
import { repositories, runs, stepRuns } from "../db/schema.js";
import type { AppDeps } from "../deps.js";

/**
 * Duplicated from `domain/runs.ts`'s private `findRepositoryByName` rather
 * than importing it — that file is issue #4's, and this issue was told not
 * to touch it. Five lines; not worth the cross-file coupling to save them.
 */
async function findRepositoryByName(
  deps: Pick<AppDeps, "db">,
  projectId: Id<"project">,
  name: string,
): Promise<typeof repositories.$inferSelect | undefined> {
  const [repo] = await deps.db
    .select()
    .from(repositories)
    .where(and(eq(repositories.projectId, projectId), eq(repositories.name, name)));
  return repo;
}

/** Steps that declare `completedStepKey` as a dependency and are not themselves a fan-out source — the same "materializable root" restriction `domain/runs.ts` applies at trigger time, just evaluated against a different edge. */
function directDependents(pipeline: Pipeline, completedStepKey: string): [string, Pipeline["steps"][string]][] {
  return Object.entries(pipeline.steps).filter(
    ([, step]) =>
      step.after.includes(completedStepKey) && step.branches === undefined && step.branchesFrom === undefined,
  );
}

/**
 * Called by `/result` after a non-fan-out StepRun (`branch_key IS NULL`)
 * commits `succeeded`. Materializes every direct dependent whose *entire*
 * `after:` list is now `succeeded` — not just this one dependency — since a
 * Step can join more than one predecessor. Idempotent: two dependencies of
 * the same downstream Step finishing at nearly the same moment both call
 * this, and the natural-key unique constraint on `step_runs (run_id,
 * step_key, branch_key, turn)` (already enforced, already has a contract
 * test) makes the second insert a no-op rather than a duplicate row.
 *
 * Silently does nothing — never throws — when the Run, its definition, or a
 * dependent Step's `repo:` can't be resolved. This runs inside `/result`'s
 * response path; a Graph-advancement problem must not turn a Runner's
 * successfully-recorded turn into a `5xx` it will needlessly retry.
 */
export async function scheduleDependentsOf(
  deps: Pick<AppDeps, "db" | "clock">,
  runId: Id<"run">,
  completedStepKey: string,
): Promise<void> {
  const [run] = await deps.db.select().from(runs).where(eq(runs.id, runId));
  if (!run || typeof run.definition !== "string") {
    return;
  }

  const validation = validatePipelineDefinition(run.definition);
  if (!validation.valid) {
    return; // Already validated once at trigger time; a re-validation failure here is not this Runner's problem to surface.
  }
  const { pipeline } = validation;

  const dependents = directDependents(pipeline, completedStepKey);
  if (dependents.length === 0) {
    return;
  }

  const allDependencyKeys = [...new Set(dependents.flatMap(([, step]) => step.after))];
  const dependencyRows = await deps.db
    .select({ stepKey: stepRuns.stepKey, outcome: stepRuns.outcome })
    .from(stepRuns)
    .where(and(eq(stepRuns.runId, runId), isNull(stepRuns.branchKey), inArray(stepRuns.stepKey, allDependencyKeys)));
  const succeededStepKeys = new Set(
    dependencyRows.filter((row) => row.outcome === "succeeded").map((row) => row.stepKey),
  );

  const readyAt = deps.clock.now();

  for (const [stepId, step] of dependents) {
    if (!step.after.every((dep) => succeededStepKeys.has(dep))) {
      continue; // still waiting on at least one other predecessor.
    }

    const repoName = step.repo ?? pipeline.repo;
    const stepRepo = await findRepositoryByName(deps, run.projectId, repoName);
    if (!stepRepo) {
      continue; // `repo:` naming a nonexistent Repository is a trigger-time validation concern for a root Step; for a downstream one there is no request to reject here, so it just never materializes.
    }

    await deps.db
      .insert(stepRuns)
      .values({
        id: generateId("steprun"),
        runId,
        repositoryId: stepRepo.id,
        stepKey: stepId,
        branchKey: null,
        turn: 1,
        attempt: 1,
        outcome: "ready",
        kind: step.kind ?? null,
        requiredTags: step.runsOn ?? [],
        readyAt,
      })
      .onConflictDoNothing();
  }
}
