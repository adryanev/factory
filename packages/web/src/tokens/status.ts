/**
 * The StepRun status vocabulary, locked in the database schema (issue 25,
 * "Enum di DB atau cek di aplikasi") and used as the binding display-rule
 * vocabulary for the monitoring UI (issue 13) and the grilling UI (issue 17):
 *
 *   ready · running · awaiting-human · succeeded · failed · skipped ·
 *   cancelled · unschedulable
 *
 * `unschedulable` (issue #25) is the terminal state of a StepRun whose
 * recorded `unschedulableAfter` deadline passed before it was claimed — the
 * explainable end of a stale queue entry, distinct from `skipped` (a Graph
 * decision) and `failed` (something broke).
 *
 * This is the one place that list is spelled out. Every primitive that draws
 * a StepRun status (StatusMark, FanOutSummary) imports it from here instead
 * of re-declaring its own union.
 */
export const STEP_RUN_STATUSES = [
  "ready",
  "running",
  "awaiting-human",
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
  "unschedulable",
] as const;

export type StepRunStatus = (typeof STEP_RUN_STATUSES)[number];
