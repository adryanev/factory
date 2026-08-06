/**
 * Automation: how Runs are triggered without a human (spec: "Automation",
 * CONTEXT.md: "Automation", ticket 22). One GitHub App webhook feeds this
 * module — a single endpoint verifies the HMAC, drops the raw event into
 * `webhook_deliveries`, and answers 2xx; every bit of mapping happens here,
 * out of GitHub's request path, on the same sweep cadence the lease and
 * notification sweeps already ride.
 *
 * This directory is split per reason-to-change (issue #26): the webhook
 * ingest (`webhook-ingest.ts`), definition acquisition and the discovery
 * cache (`definition-cache.ts`), the trigger core (`trigger.ts`), event →
 * Pipeline mapping and cancellation (`event-mapping.ts`), cron/schedule
 * (`scheduling.ts`), the `pending_automation_runs` drain
 * (`pending-queue.ts`), and the webhook delivery sweep
 * (`delivery-sweep.ts`). This facade re-exports the subsystem's public
 * surface and composes the combined sweep.
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
import type { AutomationSweepDeps } from "./deps.js";
import { sweepWebhookDeliveries } from "./delivery-sweep.js";
import { sweepPendingAutomationRuns } from "./pending-queue.js";
import { sweepSchedules } from "./scheduling.js";

export type { AutomationDeps, AutomationSweepDeps } from "./deps.js";
export type { WebhookIngestInput, WebhookIngestResult } from "./webhook-ingest.js";
export { verifyWebhookSignature, ingestWebhook } from "./webhook-ingest.js";
export type { TriggerOutcome } from "./trigger.js";
export { cancelAutomationRun } from "./event-mapping.js";
export type { CronSkipPage } from "./scheduling.js";
export { sweepSchedules, listCronSkips } from "./scheduling.js";
export { sweepPendingAutomationRuns } from "./pending-queue.js";
export { WEBHOOK_MAX_ATTEMPTS, webhookRetryBackoffMs, sweepWebhookDeliveries } from "./delivery-sweep.js";

/** The combined automation sweep — rides the same cadence as the lease sweep (boot + every executor cycle). */
export async function sweepAutomation(
  deps: AutomationSweepDeps,
): Promise<{ deliveries: number; drained: number }> {
  const deliveries = await sweepWebhookDeliveries(deps);
  const drained = await sweepPendingAutomationRuns(deps);
  await sweepSchedules(deps);
  return { deliveries, drained };
}
