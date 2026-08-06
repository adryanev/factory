/**
 * The webhook delivery sweep — the reason this module changes when the
 * dispatch cadence or retry policy changes. Processes due deliveries
 * oldest-first, with exponential backoff and dead-lettering after
 * `WEBHOOK_MAX_ATTEMPTS`. The 24h retention window is the retention sweep's
 * job (see the doc below), not this one's.
 */
import { and, asc, eq, isNull, lte } from "drizzle-orm";
import { webhookDeliveries } from "../../db/schema.js";
import type { AutomationDeps } from "./deps.js";
import { dispatchWebhookEvent } from "./event-mapping.js";

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
