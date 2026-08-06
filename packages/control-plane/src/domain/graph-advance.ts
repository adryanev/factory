/**
 * Scheduling downstream Steps was deliberately left without a caller until
 * `/result` existed: "'Hilir dijadwalkan' ... belum punya pemanggil sampai
 * `/result` ada". `/result` (`step-run-turn.ts`) is that caller, and this
 * file is what it calls the instant a StepRun reaches a terminal state.
 *
 * Issue #11 ("Fan-out dan Join") turns it into the one place a Run's Graph
 * moves, per ticket 06-dag-execution-semantics.md:
 *
 *  - A completed fan-out source Step (*`branches:`* constant or
 *    *`branchesFrom:`* reading an upstream Output) gives birth to its branch
 *    StepRuns — **one Postgres transaction** carries the decision and every
 *    branch row, so either all N branches exist or none do and the /result
 *    that triggered it is retried whole (spec: "cabang lahir saat hulu
 *    sukses ... keduanya dalam satu transaksi"). The fan-out Step itself has
 *    no `branch_key NULL` row that runs — its branches *are* its
 *    materialization (matching issue #4's trigger-time boundary, which never
 *    materializes a fan-out source). When the fan-out cannot happen — fewer
 *    branches than `minBranches`, or duplicate Keys — a single `failed` row
 *    records it (a failed fan-out has no Output, so nothing flows; its
 *    dependents are skipped).
 *  - The Join policy is owned by the Join Step (`join: all` default /
 *    `any` / `{ min: N }`), evaluated over the fan-out's branch outcomes by
 *    `joinVerdict` below. `all` fails fast on the first non-success;
 *    `any`/`min` proceed as soon as enough branches have succeeded, so an
 *    `awaiting-human` branch never holds back the others — and `all` may
 *    hang forever (spec: "Cabang awaiting-human tidak menahan cabang lain;
 *    Join all boleh menggantung selamanya"). `minBranches` (owned by the
 *    fan-out side, default 1) is what closes the "all over an empty set is
 *    true" trap: an empty fan-out fails before any Join sees it.
 *  - `skipped` means "never run because of a Graph decision" — the outcome
 *    given to a downstream Step whose upstream is `failed`/`cancelled`/
 *    `skipped`, or whose Join policy is unsatisfiable — and it propagates to
 *    *its* downstream too. It is stored as its own `outcome` value (distinct
 *    from `failed` in both data and display), never conflated.
 *  - `runs.outcome` / `runs.ended_at` are nullable and written **exactly
 *    once**, by the transaction that ends the Run (`finalizeRunIfDone`),
 *    when no StepRun is left in a non-terminal state. Nothing on the
 *    scheduling path reads them.
 *  - A Step with `kind: pull-request` (issue #17) is born here too, but it is
 *    never part of the Runner-facing advance: it materializes once per branch
 *    of its single `after:` dep when that dep is a fan-out source, or once
 *    when the dep is plain — each row `ready` for the control-plane executor
 *    (`domain/control-plane-steps.ts`) to claim as a lessee. The `join:`
 *    absence/presence is the flag that decides per-branch vs once.
 *
 * The whole thing runs inside the caller's `db.transaction` (the same one
 * that commits the terminal StepRun), so an advance that fails rolls the
 * terminal commit back too. "Hilir dijadwalkan" and "vonis akhir Run" are
 * computed, never stored as a shared field (spec: "Satu bidang menjawab dua
 * pertanyaan adalah akar kelas bug yang kita hindari").
 *
 * Shape chosen (from issue #4's own three options): **(a) materialize on
 * demand** — a downstream Step becomes a row only when it is decided, never
 * `ready` behind an unmet dependency. (b) materialize-everything-up-front +
 * a computed readiness predicate in `claim_step_run.sql` remains the more
 * literal reading of the spec's "dihitung" but means rewriting the hottest
 * query in the system and extending its contract tests; this issue keeps
 * (a) and the two remain compatible. See the #4 report for the full
 * weighing.
 */
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  generateId,
  parseDuration,
  stepRunBranchName,
  validatePipelineDefinition,
  type Id,
  type JoinManifest,
  type Pipeline,
  type Step,
} from "@factory/shared";
import { repositories, runs, stepRuns } from "../db/schema.js";
import type { Database } from "../db/client.js";
import { queueRunFailedNotification } from "./notifications.js";

/** The world this module reaches into — the caller's transaction client (or the bare db) plus the clock. */
export interface GraphDeps {
  db: Database;
  now: () => Date;
}

export type StepRunRow = typeof stepRuns.$inferSelect;
export type RunRow = typeof runs.$inferSelect;

type StepRunOutcome = StepRunRow["outcome"];
const NON_TERMINAL: Array<"ready" | "running" | "awaiting-human"> = ["ready", "running", "awaiting-human"];
const TERMINAL_NON_SUCCESS: StepRunOutcome[] = ["failed", "cancelled", "skipped", "unschedulable"];

/**
 * The recorded claim deadline of a freshly-`ready` StepRun (issue #25): the
 * materialization instant plus the Pipeline's `unschedulableAfter`, written
 * to the row once — never derived at claim time. Null when the Pipeline
 * declares no `unschedulableAfter:`; such rows stay claimable forever.
 */
export function unschedulableDeadline(pipeline: Pick<Pipeline, "unschedulableAfter">, readyAt: Date): Date | null {
  if (pipeline.unschedulableAfter === undefined) return null;
  return new Date(readyAt.getTime() + parseDuration(pipeline.unschedulableAfter));
}

/** A Step is a fan-out source iff it fans out at all — constants or a dynamic list. Exactly one of the two is enforced by the schema. */
export function isFanOutStep(step: Step): boolean {
  return step.branches !== undefined || step.branchesFrom !== undefined;
}

/**
 * Parses a Run's inline definition snapshot (validated once at trigger) back
 * into a Pipeline, or null when it is unusable. The Graph advance and the
 * Run-ending verdict both re-derive the shape of the Graph from this — the
 * snapshot is the definition the Run actually ran, not the file on the ref.
 */
export function parsePipelineSnapshot(definition: unknown): Pipeline | null {
  if (typeof definition !== "string") return null;
  const validation = validatePipelineDefinition(definition);
  return validation.valid ? validation.pipeline : null;
}

/**
 * The Steps a fan-out source must wait for before it can give birth to its
 * branches: its `after:` list, plus (for `branchesFrom:`) the Step whose
 * Output is the branch list — the schema does not require the source to be
 * in `after:`, and without it the branch list would be read before it
 * exists.
 */
function fanOutDeps(step: Step): string[] {
  const deps = [...step.after];
  if (step.branchesFrom && !deps.includes(step.branchesFrom.step)) {
    deps.push(step.branchesFrom.step);
  }
  return deps;
}

async function findRepositoryByName(
  db: Database,
  projectId: Id<"project">,
  name: string,
): Promise<typeof repositories.$inferSelect | undefined> {
  const [repo] = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.projectId, projectId), eq(repositories.name, name)));
  return repo;
}

/** Every StepRun row for one Step of the Run, newest turn first. */
async function rowsForStep(
  db: Database,
  runId: Id<"run">,
  stepKey: string,
): Promise<StepRunRow[]> {
  return db
    .select()
    .from(stepRuns)
    .where(and(eq(stepRuns.runId, runId), eq(stepRuns.stepKey, stepKey)))
    .orderBy(desc(stepRuns.turn));
}

/** The latest-turn row of a non-fan-out Step (branch_key NULL) — the "current" outcome of that Step. */
async function latestPlainRow(
  db: Database,
  runId: Id<"run">,
  stepKey: string,
): Promise<StepRunRow | undefined> {
  const rows = await rowsForStep(db, runId, stepKey);
  return rows.find((r) => r.branchKey === null);
}

/**
 * The latest-turn row per branch of a fan-out Step, plus (if it ever got
 * one) the fan-out Step's own `branch_key NULL` decision row. Used by the
 * Join verdict and the manifest builder.
 */
async function fanOutRows(
  db: Database,
  runId: Id<"run">,
  stepKey: string,
): Promise<{ decision: StepRunRow | undefined; branches: StepRunRow[] }> {
  const rows = await rowsForStep(db, runId, stepKey);
  const decision = rows.find((r) => r.branchKey === null);
  const latestByBranch = new Map<string, StepRunRow>();
  for (const row of rows) {
    if (row.branchKey === null) continue;
    const current = latestByBranch.get(row.branchKey);
    if (current === undefined || row.turn > current.turn) {
      latestByBranch.set(row.branchKey, row);
    }
  }
  return { decision, branches: [...latestByBranch.values()] };
}

export type JoinVerdict = "satisfied" | "pending" | "unsatisfiable";

/**
 * The fan-out half of the Join policy (spec: "Kebijakan `all` (bawaan) /
 * `any` / `min: N` dimiliki Join"). Evaluated over a fan-out's branch
 * outcomes:
 *
 *  - `all`: satisfied iff every branch succeeded — unsatisfiable the moment
 *    any branch is terminal-and-not-succeeded (fail fast, even while the
 *    rest still run), pending while any branch is still in flight.
 *  - `any`: satisfied as soon as one branch succeeded; pending while none
 *    has and at least one can still; unsatisfiable when all are terminal
 *    and none succeeded.
 *  - `{ min: N }`: satisfied at N successes; pending while the successful
 *    plus the still-running can still reach N; unsatisfiable when they
 *    cannot.
 *
 * A fan-out Step that itself ended `failed`/`cancelled`/`skipped` (it never
 * produced branches) is unsatisfiable under every policy — its dependents
 * have nothing to join. `minBranches` (default 1) guarantees a *succeeded*
 * fan-out never hands a Join an empty branch set unless the author wrote
 * `minBranches: 0`; over an empty set `all` is vacuously satisfied, which is
 * exactly the trap the default closes.
 */
export async function joinVerdict(
  deps: GraphDeps,
  runId: Id<"run">,
  fanOutStepKey: string,
  policy: Step["join"],
): Promise<JoinVerdict> {
  // `join:` is optional in the schema (issue #17): an omitted one means "all"
  // for a plain Join, and "born once per branch" for a kind: Step. The "all"
  // default lives here, at the single runtime call site.
  if (policy === undefined) policy = "all";
  const { decision, branches } = await fanOutRows(deps.db, runId, fanOutStepKey);
  if (decision) {
    if (TERMINAL_NON_SUCCESS.includes(decision.outcome)) return "unsatisfiable";
    if (decision.outcome !== "succeeded") return "pending";
    if (branches.length === 0) {
      // The fan-out completed with an empty list (`minBranches: 0`): the
      // Join runs with an empty manifest, whatever its policy — "barulah
      // Join berjalan dengan daftar kosong" (ticket 06). Without this marker
      // row an empty fan-out would be indistinguishable from one never born.
      return "satisfied";
    }
    // A succeeded decision row with branches is not produced by this
    // implementation (branches *are* the fan-out's materialization); fall
    // through to the branches, defensively.
  }
  if (branches.length === 0) {
    // No branches born yet (or minBranches: 0 with an empty fan-out, where
    // there is nothing to wait for and the policy below decides over the
    // empty set — but with no rows at all the fan-out simply hasn't
    // happened yet, so this is pending).
    return "pending";
  }

  let succeeded = 0;
  let pending = 0;
  let nonSuccess = 0;
  for (const branch of branches) {
    if (branch.outcome === "succeeded") succeeded += 1;
    else if (TERMINAL_NON_SUCCESS.includes(branch.outcome)) nonSuccess += 1;
    else pending += 1;
  }

  if (policy === "all") {
    if (nonSuccess > 0) return "unsatisfiable";
    if (pending > 0) return "pending";
    return "satisfied";
  }
  if (policy === "any") {
    if (succeeded > 0) return "satisfied";
    if (pending > 0) return "pending";
    return "unsatisfiable";
  }
  if (succeeded >= policy.min) return "satisfied";
  if (succeeded + pending >= policy.min) return "pending";
  return "unsatisfiable";
}

/**
 * "Should this Step run, given the current rows?" — a downstream Step is
 * decided the moment every fan-out source in its `after:` list has a
 * resolved Join verdict and every plain dependency has a terminal outcome.
 * Never reads `runs.outcome` — the scheduling path stays blind to the Run's
 * final verdict (spec: "Jalur penjadwalan tidak pernah membacanya").
 */
async function evaluateStep(
  deps: GraphDeps,
  run: RunRow,
  pipeline: Pipeline,
  stepId: string,
): Promise<"ready" | "skipped" | "pending"> {
  const step = pipeline.steps[stepId]!;
  for (const depId of fanOutDeps(step)) {
    const depStep = pipeline.steps[depId]!;
    if (isFanOutStep(depStep)) {
      const verdict = await joinVerdict(deps, run.id, depId, step.join);
      if (verdict === "unsatisfiable") return "skipped";
      if (verdict === "pending") return "pending";
      continue;
    }
    const row = await latestPlainRow(deps.db, run.id, depId);
    if (!row) return "pending"; // not materialized yet.
    if (row.outcome === "succeeded") continue;
    if (TERMINAL_NON_SUCCESS.includes(row.outcome)) return "skipped";
    return "pending"; // ready / running / awaiting-human
  }
  return "ready";
}

interface ResolvedBranch {
  key: string;
  repoName: string;
  requiredTags: string[];
}

/** The structured Output map a branch/Step produced — unwraps the `{ kind: 'done', outputs }` envelope the /result gate stores. Shared with the control-plane Step executor (issue #17) to resolve `title:`/`body:` references. */
export function structuredOutputs(outputData: unknown): unknown {
  if (typeof outputData === "object" && outputData !== null && "outputs" in outputData) {
    return (outputData).outputs;
  }
  return outputData;
}

/**
 * The branch list a fan-out source would give birth to, with each branch's effective repo and runsOn.
 * For `branchesFrom:` the list is read from the source Step's Output — the value of the named field
 * inside the `done` arm's structured outputs, which was validated by the /result gate.
 */
async function resolveFanOutBranches(
  deps: GraphDeps,
  run: RunRow,
  pipeline: Pipeline,
  stepId: string,
): Promise<{ ok: true; branches: ResolvedBranch[] } | { ok: false; reason: string }> {
  const step = pipeline.steps[stepId]!;

  let entries: Array<{ key: string }> = [];
  if (step.branches !== undefined) {
    entries = step.branches.map((branch) => ({ key: branch.key }));
  } else if (step.branchesFrom !== undefined) {
    const source = await latestPlainRow(deps.db, run.id, step.branchesFrom.step);
    const outputs = structuredOutputs(source?.outputData);
    const value =
      typeof outputs === "object" && outputs !== null && step.branchesFrom.output in outputs
        ? (outputs as Record<string, unknown>)[step.branchesFrom.output]
        : undefined;
    if (!Array.isArray(value)) {
      return { ok: false, reason: "fan-out-source-unresolved" };
    }
    const malformed = value.some(
      (item) =>
        typeof item !== "object" || item === null || typeof (item as { key?: unknown }).key !== "string",
    );
    if (malformed) {
      return { ok: false, reason: "fan-out-source-invalid" };
    }
    entries = (value as Array<{ key: string }>).map((item) => ({ key: item.key }));
  } else {
    return { ok: false, reason: "fan-out-no-source" };
  }

  // Keys are compared exactly, case-sensitively — slug normalisation is
  // never applied (spec: "Normalisasi slug ditolak"). Exact duplicates are
  // caught here; the natural-key unique constraint
  // `(run_id, step_key, branch_key, turn)` NULLS NOT DISTINCT is the
  // structural backstop (spec: "ditegakkan struktural").
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.key)) {
      return { ok: false, reason: "fan-out-duplicate-key" };
    }
    seen.add(entry.key);
  }

  const branches: ResolvedBranch[] = [];
  for (const entry of entries) {
    const branchDef = step.branches?.find((b) => b.key === entry.key);
    const repoName = branchDef?.repo ?? step.repo ?? pipeline.repo;
    const runsOn = branchDef?.runsOn ?? step.runsOn;
    branches.push({ key: entry.key, repoName, requiredTags: runsOn ?? [] });
  }
  return { ok: true, branches };
}

/**
 * Gives birth to a fan-out source's branches — the "cabang lahir saat hulu
 * sukses" transaction. Called only after `evaluateStep` said the fan-out is
 * runnable, inside the same transaction that committed the upstream /result.
 * On success every branch row exists or none do (the caller's transaction
 * aborts the whole /result otherwise). On failure — fewer branches than
 * `minBranches`, or duplicate Keys — inserts one `failed` StepRun for the
 * fan-out Step itself and returns `"failed"`; its dependents are then
 * evaluated against that decision.
 */
export async function materializeFanOut(
  deps: GraphDeps,
  run: RunRow,
  pipeline: Pipeline,
  stepId: string,
): Promise<"ok" | "ok-empty" | "failed"> {
  const step = pipeline.steps[stepId]!;
  const resolved = await resolveFanOutBranches(deps, run, pipeline, stepId);
  if (!resolved.ok) {
    await insertFanOutDecision(deps, run, stepId, "failed", resolved.reason);
    return "failed";
  }
  if (resolved.branches.length < (step.minBranches ?? 1)) {
    await insertFanOutDecision(deps, run, stepId, "failed", "fan-out-empty");
    return "failed";
  }
  if (resolved.branches.length === 0) {
    // minBranches: 0 with an empty list — a legal, explicit choice. Record
    // the fan-out as *decided* with an empty result so downstream Joins run
    // against an empty manifest instead of hanging on "not born yet".
    await insertFanOutDecision(deps, run, stepId, "succeeded", null);
    return "ok-empty";
  }

  const readyAt = deps.now();
  for (const branch of resolved.branches) {
    const repo = await findRepositoryByName(deps.db, run.projectId, branch.repoName);
    if (!repo) {
      // A `repo:` naming a nonexistent Repository is a trigger-time
      // validation error for a root fan-out; for a downstream one there is
      // no request to reject here, so the fan-out fails and nothing is born.
      await insertFanOutDecision(deps, run, stepId, "failed", "fan-out-repo-not-found");
      return "failed";
    }
    await deps.db
      .insert(stepRuns)
      .values({
        id: generateId("steprun"),
        runId: run.id,
        repositoryId: repo.id,
        stepKey: stepId,
        branchKey: branch.key,
        turn: 1,
        attempt: 1,
        outcome: "ready",
        kind: null,
        requiredTags: branch.requiredTags,
        readyAt,
        unschedulableAfter: unschedulableDeadline(pipeline, readyAt),
      });
  }
  return "ok";
}

/** The `branch_key NULL` row recording a fan-out's decision: `failed` when it could not happen (below minBranches, duplicate Keys, unresolvable source), `succeeded` when it completed with an empty list (`minBranches: 0`). */
async function insertFanOutDecision(
  deps: GraphDeps,
  run: RunRow,
  stepId: string,
  outcome: "failed" | "succeeded",
  reason: string | null,
): Promise<void> {
  await deps.db
    .insert(stepRuns)
    .values({
      id: generateId("steprun"),
      runId: run.id,
      repositoryId: run.pipelineRepositoryId,
      stepKey: stepId,
      branchKey: null,
      turn: 1,
      attempt: 1,
      outcome,
      reason,
      kind: null,
      requiredTags: [],
      readyAt: deps.now(),
    })
    .onConflictDoNothing();
}

/** Inserts the `branch_key NULL` row recording a plain Step's decision (ready to run, or skipped without running). Idempotent on the natural key. */
async function insertPlainDecision(
  deps: GraphDeps,
  run: RunRow,
  pipeline: Pipeline,
  stepId: string,
  outcome: "ready" | "skipped",
  reason: string | null,
): Promise<void> {
  const step = pipeline.steps[stepId]!;
  const repoName = step.repo ?? pipeline.repo;
  const repo = await findRepositoryByName(deps.db, run.projectId, repoName);
  if (!repo) return; // an unresolvable `repo:` is a trigger-time concern for roots; a downstream one simply never materializes.
  const readyAt = deps.now();
  await deps.db
    .insert(stepRuns)
    .values({
      id: generateId("steprun"),
      runId: run.id,
      repositoryId: repo.id,
      stepKey: stepId,
      branchKey: null,
      turn: 1,
      attempt: 1,
      outcome,
      reason,
      kind: step.kind ?? null,
      requiredTags: step.runsOn ?? [],
      readyAt,
      // Only a `ready` row can be claimed — the deadline is what the claim
      // query and the unschedulable sweep read (issue #25).
      unschedulableAfter: outcome === "ready" ? unschedulableDeadline(pipeline, readyAt) : null,
    })
    .onConflictDoNothing();
}

/**
 * The `kind: pull-request` StepRun row — a control-plane Step never declares
 * `repo:` (it inherits the branch it follows), so the repository comes from
 * the upstream row, not the definition (issue #17, AC3). turn is always 1
 * (kind Steps are executed in seconds; there are no resumed turns, ticket 24).
 */
async function insertKindDecision(
  deps: GraphDeps,
  run: RunRow,
  pipeline: Pipeline,
  stepId: string,
  outcome: "ready" | "skipped",
  reason: string | null,
  branchKey: string | null,
  repositoryId: Id<"repository">,
): Promise<void> {
  const readyAt = deps.now();
  await deps.db
    .insert(stepRuns)
    .values({
      id: generateId("steprun"),
      runId: run.id,
      repositoryId,
      stepKey: stepId,
      branchKey,
      turn: 1,
      attempt: 1,
      outcome,
      reason,
      kind: "pull-request",
      requiredTags: [],
      readyAt,
      // Pipeline-level `unschedulableAfter:` covers every StepRun of the
      // Run, control-plane Steps included (issue #25).
      unschedulableAfter: outcome === "ready" ? unschedulableDeadline(pipeline, readyAt) : null,
    })
    .onConflictDoNothing();
}

/**
 * Materializes a `kind: pull-request` StepRun after its single `after:` dep
 * reached a terminal state (issue #17). The kind Step is born **once per
 * branch** when the dep is a fan-out source (each branch gets its own PR, in
 * that branch's repo — "PR-per-repo jatuh gratis", ticket 21/24), and **once**
 * when the dep is a plain Step (the PR follows that one branch). A terminal
 * non-success upstream makes the kind Step `skipped` — there is nothing to
 * open a PR for. Idempotent on the natural key, so re-advancing after a later
 * branch finishes is a no-op for the rows already born.
 */
async function materializeKindStep(
  deps: GraphDeps,
  run: RunRow,
  pipeline: Pipeline,
  stepId: string,
): Promise<void> {
  const step = pipeline.steps[stepId]!;
  const depKey = step.after[0]!;
  const depStep = pipeline.steps[depKey]!;

  if (isFanOutStep(depStep)) {
    // Per-branch birth. A fan-out that failed or was skipped has no branches —
    // record a single `skipped` decision so the leaf exists and the Graph is
    // complete ("Run yang tidak menghasilkan apa pun tidak boleh mengaku
    // sukses").
    const { decision, branches } = await fanOutRows(deps.db, run.id, depKey);
    if (branches.length === 0 && decision && TERMINAL_NON_SUCCESS.includes(decision.outcome)) {
      await insertKindDecision(
        deps,
        run,
        pipeline,
        stepId,
        "skipped",
        "upstream-not-runnable",
        null,
        decision.repositoryId,
      );
      return;
    }
    for (const branch of branches) {
      if (branch.outcome === "succeeded") {
        await insertKindDecision(deps, run, pipeline, stepId, "ready", null, branch.branchKey, branch.repositoryId);
      } else if (TERMINAL_NON_SUCCESS.includes(branch.outcome)) {
        await insertKindDecision(deps, run, pipeline, stepId, "skipped", "upstream-not-runnable", branch.branchKey, branch.repositoryId);
      }
      // A branch still in flight has no PR row yet — it is born when it succeeds.
    }
    return;
  }

  // Plain dep: born once, inheriting the dep's repo.
  const depRow = await latestPlainRow(deps.db, run.id, depKey);
  if (!depRow) return; // not materialized yet — wait.
  if (depRow.outcome === "succeeded") {
    await insertKindDecision(deps, run, pipeline, stepId, "ready", null, null, depRow.repositoryId);
  } else if (TERMINAL_NON_SUCCESS.includes(depRow.outcome)) {
    await insertKindDecision(deps, run, pipeline, stepId, "skipped", "upstream-not-runnable", null, depRow.repositoryId);
  }
}

/**
 * Advances the Graph after one StepRun reached a terminal state: the fan-out
 * decision, the Join verdicts, and skip propagation all live here. Idempotent
 * — re-advancing from an already-decided Step is a no-op (`onConflictDoNothing`
 * plus the "branches already born" guard), which is what makes two concurrent
 * `/result`s for sibling branches safe under the transaction.
 *
 * Runs silently inside the caller's transaction; never throws for a
 * Graph-shape problem (an advance failure must not turn a Runner's
 * successfully-recorded turn into a retried 5xx).
 */
export async function advanceGraph(
  deps: GraphDeps,
  run: RunRow,
  pipeline: Pipeline,
  triggeredStepKey: string,
): Promise<void> {
  const worklist = [triggeredStepKey];
  const queued = new Set(worklist);

  while (worklist.length > 0) {
    const completedKey = worklist.shift()!;
    queued.delete(completedKey);

    for (const [stepId, step] of Object.entries(pipeline.steps)) {
      const dependsOn =
        step.after.includes(completedKey) ||
        step.branchesFrom?.step === completedKey;
      if (!dependsOn) continue;

      // Control-plane Steps (`kind:`) are born by issue #17 — once per branch
      // when their single dep is a fan-out source, once when it is plain —
      // and executed by the control plane itself as a lessee. The ordinary
      // Runner-facing advance never touches them.
      if (step.kind !== undefined) {
        await materializeKindStep(deps, run, pipeline, stepId);
        continue;
      }

      const decision = await evaluateStep(deps, run, pipeline, stepId);
      if (decision === "pending") continue;

      if (decision === "skipped") {
        await insertPlainDecision(deps, run, pipeline, stepId, "skipped", "upstream-not-runnable");
        if (!queued.has(stepId)) {
          queued.add(stepId);
          worklist.push(stepId);
        }
        continue;
      }

      // Ready. A fan-out source gives birth to its branches instead of a
      // `branch_key NULL` row.
      if (isFanOutStep(step)) {
        const existing = await rowsForStep(deps.db, run.id, stepId);
        if (existing.length > 0) continue; // branches (or a decision row) already exist.
        const outcome = await materializeFanOut(deps, run, pipeline, stepId);
        if (outcome !== "ok" && !queued.has(stepId)) {
          // `failed` (nothing to join) or `ok-empty` (an empty manifest is a
          // decision) — either way this fan-out is *decided* now, so its
          // dependents must be re-evaluated.
          queued.add(stepId);
          worklist.push(stepId);
        }
        continue;
      }

      await insertPlainDecision(deps, run, pipeline, stepId, "ready", null);
    }
  }
}

/**
 * Ends the Run when nothing is left in flight — the one place
 * `runs.outcome`/`runs.ended_at` are ever written, guarded by
 * `WHERE outcome IS NULL` so exactly one transaction wins even if two
 * sibling branches finish concurrently. The verdict follows ticket 06's
 * precedence over the *leaf* Steps (Steps nothing depends on): any leaf
 * `failed` → Run `failed`; any `cancelled` (without `failed`) → `cancelled`;
 * ≥1 `succeeded` with the rest `skipped` → `succeeded`; all `skipped` (or no
 * leaves produced anything) → `failed` — "Run yang tidak menghasilkan apa
 * pun tidak boleh mengaku sukses". A fan-out leaf is its branches; a fan-out
 * that failed or was skipped contributes its own decision row.
 */
export async function finalizeRunIfDone(
  deps: GraphDeps,
  runId: Id<"run">,
  pipeline: Pipeline,
): Promise<void> {
  const inFlight = await deps.db
    .select({ id: stepRuns.id })
    .from(stepRuns)
    .where(and(eq(stepRuns.runId, runId), inArray(stepRuns.outcome, NON_TERMINAL)))
    .limit(1);
  if (inFlight.length > 0) return;

  const leafStepIds = Object.keys(pipeline.steps).filter(
    (id) => !Object.values(pipeline.steps).some((other) => other.after.includes(id)),
  );

  const outcomes: string[] = [];
  for (const leafId of leafStepIds) {
    const leaf = pipeline.steps[leafId]!;
    if (isFanOutStep(leaf)) {
      const { decision, branches } = await fanOutRows(deps.db, runId, leafId);
      if (branches.length > 0) {
        outcomes.push(...branches.map((b) => b.outcome));
      } else if (decision) {
        outcomes.push(decision.outcome);
      }
      continue;
    }
    // A `kind:` leaf is born per branch (fan-out dep) or once (plain dep) —
    // either way its rows are the per-branch/per-decision picture, read the
    // same way a fan-out leaf's are.
    if (leaf.kind !== undefined) {
      const { decision, branches } = await fanOutRows(deps.db, runId, leafId);
      if (decision) outcomes.push(decision.outcome);
      if (branches.length > 0) outcomes.push(...branches.map((b) => b.outcome));
      continue;
    }
    const row = await latestPlainRow(deps.db, runId, leafId);
    if (row) outcomes.push(row.outcome);
  }

  let verdict: "succeeded" | "failed" | "cancelled";
  if (outcomes.includes("failed")) verdict = "failed";
  else if (outcomes.includes("cancelled")) verdict = "cancelled";
  else if (outcomes.includes("succeeded")) verdict = "succeeded";
  else verdict = "failed"; // all skipped, or nothing was ever produced.

  const endedAt = deps.now();
  const ended = await deps.db
    .update(runs)
    .set({ outcome: verdict, endedAt })
    .where(and(eq(runs.id, runId), isNull(runs.outcome)))
    .returning({ projectId: runs.projectId });
  if (verdict === "failed" && ended.length > 0) {
    await queueRunFailedNotification(deps.db, ended[0]!.projectId, runId, endedAt);
  }
}

/**
 * Builds the Join manifest a claimed StepRun needs: one entry per branch of
 * every fan-out Step in its `after:` list. The Join receives the branches as
 * data (`[{ key, repo, branch, sha, outcome, outputs }]`) and fetches only
 * the branches that share its own repo — cross-repo branches are reads, not
 * checkouts (ticket 21). Null for a Step that joins nothing.
 */
export async function buildJoinManifest(
  db: Database,
  run: RunRow,
  pipeline: Pipeline,
  step: Step,
): Promise<JoinManifest | null> {
  const fanOutDepIds = step.after.filter((depId) => isFanOutStep(pipeline.steps[depId]!));
  if (fanOutDepIds.length === 0) return null;

  const entries: JoinManifest = [];
  for (const depId of fanOutDepIds) {
    const { branches } = await fanOutRows(db, run.id, depId);
    for (const branch of branches) {
      const repository = await db
        .select({ name: repositories.name })
        .from(repositories)
        .where(eq(repositories.id, branch.repositoryId))
        .then((rows) => rows[0]);
      entries.push({
        key: branch.branchKey!,
        repo: repository?.name ?? "unknown",
        branch: stepRunBranchName({
          runId: branch.runId,
          stepKey: branch.stepKey,
          branchKey: branch.branchKey,
          turn: branch.turn,
          attempt: branch.attempt,
        }),
        sha: branch.outputRefSha,
        outcome: branch.outcome,
        outputs: structuredOutputs(branch.outputData),
      });
    }
  }
  return entries;
}
