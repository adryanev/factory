/**
 * Two StepRun-scoped operations that don't belong to the Runner protocol
 * itself: an operator's cancel button, and the lease-expiry sweep. Neither
 * touches Graph advancement or Run-level orchestration (issue #4's), only
 * this one row.
 */
import { and, asc, eq, isNotNull, isNull, lte, lt, sql } from "drizzle-orm";
import { generateId, renderHumanTimeoutForAgent, type Id } from "@factory/shared";
import { questions, runs, stepRuns } from "../db/schema.js";
import type { AppDeps } from "../deps.js";
import type { Principal } from "./principal.js";
import { requireProjectMembership } from "./projects.js";
import { DomainValidationError, NotFoundError } from "./errors.js";
import {
  advanceGraph,
  finalizeRunIfDone,
  parsePipelineSnapshot,
  unschedulableDeadline,
} from "./graph-advance.js";
import { questionFromRow } from "./step-run-questions.js";
import { sweepPendingNotifications } from "./notifications.js";
import { sweepAutomation } from "./automation/index.js";

const TERMINAL_OUTCOMES = new Set(["succeeded", "failed", "cancelled", "skipped", "unschedulable"]);

/**
 * Operator cancel: the row goes `cancelled` immediately so the UI changes at
 * once (spec: "Cancel otoritatif di control plane ... baris langsung
 * cancelled"). Gated on Project membership (`member`, the same level the web
 * <-> control-plane contract gives "Cancel Run") — resolved via
 * `step_runs.run_id -> runs.project_id`, a read join, not a write into
 * issue #4's `runs`/Graph domain.
 *
 * A cancelled StepRun is terminal, so the Graph advances from it in the same
 * transaction — dependents whose policy is now unsatisfiable become
 * `skipped` (and propagate), and a Run with nothing left in flight ends with
 * its final verdict. Cancel stays a single-row write for the UI's sake; the
 * advance just rides the same commit.
 */
export async function cancelStepRun(
  deps: Pick<AppDeps, "db" | "clock">,
  principal: Principal,
  stepRunId: Id<"steprun">,
): Promise<void> {
  const [row] = await deps.db
    .select({ stepRun: stepRuns, projectId: runs.projectId })
    .from(stepRuns)
    .innerJoin(runs, eq(runs.id, stepRuns.runId))
    .where(eq(stepRuns.id, stepRunId));

  if (!row) {
    throw new NotFoundError("step run", stepRunId);
  }

  await requireProjectMembership(deps, principal, row.projectId);

  if (row.stepRun.outcome === "cancelled") {
    return; // idempotent — a second click is not an error.
  }
  if (TERMINAL_OUTCOMES.has(row.stepRun.outcome)) {
    throw new DomainValidationError(
      "step_run_already_ended",
      `step run ${stepRunId} already ended with outcome ${row.stepRun.outcome}; it cannot be cancelled`,
    );
  }

  await deps.db.transaction(async (tx) => {
    await tx
      .update(stepRuns)
      .set({ outcome: "cancelled", reason: "cancelled-by-operator" })
      .where(eq(stepRuns.id, stepRunId));

    const [run] = await tx.select().from(runs).where(eq(runs.id, row.stepRun.runId));
    if (!run) return;
    const pipeline = parsePipelineSnapshot(run.definition);
    if (!pipeline) return;
    await advanceGraph({ db: tx, now: deps.clock.now }, run, pipeline, row.stepRun.stepKey);
    await finalizeRunIfDone({ db: tx, now: deps.clock.now }, run.id, pipeline);
  });
}

/**
 * Lease-expiry sweep (spec: "Lease hilang -> sweep -> dijadwalkan ulang
 * sebagai attempt baru dengan reason tercatat terpisah"). Expressed through
 * Drizzle, not hand-written SQL — unlike `claim_step_run.sql`, this is a
 * single unconditional `UPDATE ... WHERE ...`, and Postgres's own per-row
 * lock-then-recheck behavior on `UPDATE` already makes two concurrent
 * sweepers safe with no `FOR UPDATE SKIP LOCKED` needed: a sweeper blocked
 * on a row a moment ago re-evaluates the `WHERE` clause after the first
 * sweeper's commit, and `outcome = 'running'` no longer matches — the spec's
 * "hanya tiga hal ditulis SQL tangan" list (append-only trigger, claim
 * query, retention sweeps) does not include this one.
 *
 * Deliberately does not consult a Step's `attempts:` policy ceiling — that
 * requires the compiled Pipeline definition for this Step, which lives in
 * issue #4's Graph/pipeline domain, untouched here. This sweep always
 * reschedules; "give up after N attempts" is that domain's job to enforce
 * on top of the `attempt` counter this sweep increments.
 *
 * Compares against Postgres's `now()`, not `deps.clock`'s — `lease_expires_at`
 * was itself stamped by `claim_step_run.sql`'s `now()`; see `runners.ts`'s
 * heartbeat renewal for the same reasoning, spelled out once there.
 */
export async function sweepExpiredLeases(
  deps: Pick<AppDeps, "db"> &
    Partial<Pick<AppDeps, "clock" | "notificationSender" | "gitHost" | "automationScheduleWatermark">>,
): Promise<Id<"steprun">[]> {
  const rows = await deps.db
    .update(stepRuns)
    .set({
      outcome: "ready",
      attempt: sql`${stepRuns.attempt} + 1`,
      leasedBy: null,
      leaseToken: null,
      leaseExpiresAt: null,
      readyAt: sql`now()`,
      reason: "lease-lost",
    })
    .where(and(eq(stepRuns.outcome, "running"), lt(stepRuns.leaseExpiresAt, sql`now()`)))
    .returning({ id: stepRuns.id });
  if (deps.clock && deps.notificationSender) {
    await sweepPendingNotifications({
      db: deps.db,
      clock: deps.clock,
      notificationSender: deps.notificationSender,
    });
  }
  if (deps.clock && deps.gitHost && deps.automationScheduleWatermark) {
    // Issue #18: webhook deliveries → triggers, the concurrency-queue drain,
    // and the schedule sweep ride the same cadence (boot + every executor
    // cycle) as the lease and notification sweeps — no poller of their own.
    await sweepAutomation({
      db: deps.db,
      clock: deps.clock,
      gitHost: deps.gitHost,
      scheduleWatermark: deps.automationScheduleWatermark,
    });
  }
  if (deps.clock) {
    // Issue #25: stale `ready` StepRuns past their recorded
    // `unschedulable_after` move to the terminal `unschedulable` outcome on
    // the same cadence — the claim query already refuses them, this is what
    // makes the state visible and advances the Graph from it.
    await sweepUnschedulable({ db: deps.db, clock: deps.clock });
    // Issue #24: `awaiting-human` StepRuns past their recorded
    // `human_deadline` move per the Step's `onHumanTimeout:` on the same
    // cadence — this is what makes the declared `humanTimeout:` real.
    await sweepHumanTimeouts({ db: deps.db, clock: deps.clock });
  }
  return rows.map((row) => row.id);
}

/**
 * The unschedulable sweep (issue #25): every `ready` StepRun whose recorded
 * `unschedulable_after` has passed — compared against the injected clock,
 * the same clock that stamped the deadline at materialization (the pair is
 * consistent by construction; `automation.ts`'s `ingestWebhook` documents
 * the same rule for `next_attempt_at`). Each row transitions to the terminal
 * `unschedulable` outcome with a recorded reason, and the Graph advances
 * from it in the same transaction — dependents become `skipped` (the Join
 * policy reads `unschedulable` as a terminal non-success) and the Run ends
 * with its verdict when nothing is left in flight.
 *
 * Indexed scan that shrinks while working (spec): the candidate SELECT walks
 * the partial `step_runs_unschedulable_ready_idx` (`unschedulable_after`
 * WHERE `outcome = 'ready'`), and a transitioned row drops out of that
 * index — the next round never rescans it. Two concurrent sweepers are safe
 * the way the lease sweep is: the UPDATE's `outcome = 'ready'` guard is
 * re-evaluated after the other sweeper's commit, so the loser updates zero
 * rows and the advance never runs twice for one row.
 */
export async function sweepUnschedulable(
  deps: Pick<AppDeps, "db" | "clock">,
): Promise<Id<"steprun">[]> {
  const now = deps.clock.now();
  const expired = await deps.db
    .select()
    .from(stepRuns)
    .where(
      and(
        eq(stepRuns.outcome, "ready"),
        isNotNull(stepRuns.unschedulableAfter),
        lte(stepRuns.unschedulableAfter, now),
      ),
    );

  const transitioned: Id<"steprun">[] = [];
  for (const row of expired) {
    const changed = await deps.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(stepRuns)
        .set({ outcome: "unschedulable", reason: "unschedulable-after-elapsed" })
        .where(and(eq(stepRuns.id, row.id), eq(stepRuns.outcome, "ready")))
        .returning({ stepKey: stepRuns.stepKey, runId: stepRuns.runId });
      if (!updated) return false; // a concurrent sweeper transitioned it first.
      const [run] = await tx.select().from(runs).where(eq(runs.id, updated.runId));
      if (!run) return true;
      const pipeline = parsePipelineSnapshot(run.definition);
      if (!pipeline) return true;
      await advanceGraph({ db: tx, now: deps.clock.now }, run, pipeline, updated.stepKey);
      await finalizeRunIfDone({ db: tx, now: deps.clock.now }, run.id, pipeline);
      return true;
    });
    if (changed) transitioned.push(row.id);
  }
  return transitioned;
}

/**
 * The human-timeout sweep (issue #24): every `awaiting-human` StepRun whose
 * recorded `human_deadline` has passed — compared against the injected
 * clock, the same clock that stamped the deadline the moment the row entered
 * `awaiting-human` (`submitQuestion`'s `humanTimeoutDeadline`; the pair is
 * consistent by construction, the same rule `sweepUnschedulable` documents
 * for `unschedulable_after`). Each row moves per the Step's `onHumanTimeout:`
 * (schema: `z.enum(["fail", "continue"])`):
 *
 *  - `fail`: the row becomes the terminal `failed` outcome with the recorded
 *    reason `human-timeout`, and the Graph advances from it in the same
 *    transaction — dependents become `skipped` and the Run ends with its
 *    verdict when nothing is left in flight.
 *  - `continue`: the unanswered turn ends (`succeeded`) and a new turn is
 *    born at `turn + 1, attempt: 1`, `outcome: ready`, carrying the session
 *    (blob + id), the ref the previous turn pushed, and a rendered "no one
 *    answered" resume prompt — the conversation moves on without a human
 *    answer, the way `answerQuestion` moves it on with one.
 *
 * The runtime default for an *omitted* `onHumanTimeout` is `continue` — the
 * same lenient default `onReject` carries — applied here, at the single
 * call site, the same way the schema's other no-default fields get theirs
 * (`join ?? "all"`). The schema itself rejects `onHumanTimeout` without a
 * non-`none` `humanTimeout`, so a row with a recorded deadline always has a
 * well-defined policy.
 *
 * Indexed scan that shrinks while working (spec): the candidate SELECT walks
 * the partial `step_runs_human_timeout_idx` (`human_deadline` WHERE
 * `outcome = 'awaiting-human'`), and a transitioned row drops out of that
 * index — the next round never rescans it. Two concurrent sweepers are safe
 * the way the lease and unschedulable sweeps are: the UPDATE's
 * `outcome = 'awaiting-human'` guard is re-evaluated after the other
 * sweeper's commit, so the loser updates zero rows and the transition (and
 * the turn birth, or the Graph advance) never runs twice for one row.
 */
export async function sweepHumanTimeouts(
  deps: Pick<AppDeps, "db" | "clock">,
): Promise<Id<"steprun">[]> {
  const now = deps.clock.now();
  const expired = await deps.db
    .select()
    .from(stepRuns)
    .where(
      and(
        eq(stepRuns.outcome, "awaiting-human"),
        isNotNull(stepRuns.humanDeadline),
        lte(stepRuns.humanDeadline, now),
      ),
    );

  const transitioned: Id<"steprun">[] = [];
  for (const row of expired) {
    const changed = await deps.db.transaction(async (tx) => {
      const [run] = await tx.select().from(runs).where(eq(runs.id, row.runId));
      if (!run) return false;
      const pipeline = parsePipelineSnapshot(run.definition);
      const step = pipeline?.steps[row.stepKey];
      const continueTurn =
        pipeline !== null && step !== undefined && step.onHumanTimeout !== "fail";

      if (continueTurn) {
        const [question] = await tx
          .select()
          .from(questions)
          .where(and(eq(questions.stepRunId, row.id), isNull(questions.answeredAt)))
          .orderBy(asc(questions.createdAt))
          .limit(1);
        if (question) {
          const [updated] = await tx
            .update(stepRuns)
            .set({ outcome: "succeeded" })
            .where(and(eq(stepRuns.id, row.id), eq(stepRuns.outcome, "awaiting-human")))
            .returning({ id: stepRuns.id });
          if (!updated) return false; // a concurrent sweeper transitioned it first.

          // Birth the next turn, mirroring `answerQuestion`'s continue path —
          // and carrying `unschedulable_after` the #25 doctrine demands of
          // every freshly-`ready` row.
          await tx.insert(stepRuns).values({
            id: generateId("steprun"),
            runId: row.runId,
            repositoryId: row.repositoryId,
            stepKey: row.stepKey,
            branchKey: row.branchKey,
            turn: row.turn + 1,
            attempt: 1,
            outcome: "ready",
            kind: row.kind,
            requiredTags: row.requiredTags,
            readyAt: now,
            unschedulableAfter: unschedulableDeadline(pipeline, now),
            sessionBlobKey: row.sessionBlobKey,
            sessionId: row.sessionId,
            resumePrompt: renderHumanTimeoutForAgent(questionFromRow(question)),
            outputRefBranch: row.outputRefBranch,
            outputRefSha: row.outputRefSha,
          });
          return true;
        }
        // An awaiting-human row always carries one open Question
        // (`submitQuestion` writes both in one transaction); when it is
        // missing, the continue promise cannot be honored — fall through to
        // `fail` rather than leave the row waiting forever (the original bug).
      }

      const [updated] = await tx
        .update(stepRuns)
        .set({ outcome: "failed", reason: "human-timeout" })
        .where(and(eq(stepRuns.id, row.id), eq(stepRuns.outcome, "awaiting-human")))
        .returning({ id: stepRuns.id });
      if (!updated) return false; // a concurrent sweeper transitioned it first.
      if (pipeline) {
        await advanceGraph({ db: tx, now: deps.clock.now }, run, pipeline, row.stepKey);
        await finalizeRunIfDone({ db: tx, now: deps.clock.now }, run.id, pipeline);
      }
      return true;
    });
    if (changed) transitioned.push(row.id);
  }
  return transitioned;
}
