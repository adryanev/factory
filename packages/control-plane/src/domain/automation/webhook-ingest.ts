/**
 * Webhook verification + ingest — the reason this module changes when
 * GitHub's signature scheme or the ingest contract changes. Nothing else
 * happens here: every bit of mapping lives in `event-mapping.ts`, on the
 * sweep, out of GitHub's request path.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { webhookDeliveries } from "../../db/schema.js";
import { DomainValidationError, UnauthorizedError } from "../errors.js";
import type { AutomationDeps } from "./deps.js";

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
