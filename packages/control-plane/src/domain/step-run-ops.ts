/**
 * Two StepRun-scoped operations that don't belong to the Runner protocol
 * itself: an operator's cancel button, and the lease-expiry sweep. Neither
 * touches Graph advancement or Run-level orchestration (issue #4's), only
 * this one row.
 */
import { and, eq, lt, sql } from "drizzle-orm";
import type { Id } from "@factory/shared";
import { runs, stepRuns } from "../db/schema.js";
import type { AppDeps } from "../deps.js";
import type { Principal } from "./principal.js";
import { requireProjectMembership } from "./projects.js";
import { DomainValidationError, NotFoundError } from "./errors.js";
import { advanceGraph, finalizeRunIfDone, parsePipelineSnapshot } from "./graph-advance.js";
import { sweepPendingNotifications } from "./notifications.js";
import { sweepAutomation } from "./automation.js";

const TERMINAL_OUTCOMES = new Set(["succeeded", "failed", "cancelled", "skipped"]);

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
  return rows.map((row) => row.id);
}
