/**
 * Issue #23 — webhook delivery retention is bounded: the 24h retention
 * sweep clears `payload` (the full raw GitHub event bytes) from processed
 * deliveries while the row — the layer-1 dedup key — survives forever.
 * Before this issue, the old hard-DELETE was dropped and replaced with the
 * `purged_at` marker, but nothing ever reclaimed the payload bytes, so the
 * table grew one full event per webhook, forever.
 *
 * Over the seam-1 rig (real Postgres, real HTTP), with the delivery rows
 * backdated directly — the retention SQL compares `received_at` against the
 * real Postgres `now()`, so the rig's injected clock cannot drive that
 * window; a fixed timestamp far in the past is the deterministic route
 * (same pattern as automation.test.ts's "older than 24h" test):
 *
 *  - three processed deliveries past the 24h window: purged in round one —
 *    `payload` becomes NULL, `purged_at` is set, the rows still exist;
 *  - an unprocessed delivery of the same age: NOT a candidate — it still
 *    needs its payload for dispatch, and after the mapping sweep runs it is
 *    purged by the next round (never lost, never dispatched empty);
 *  - a fresh delivery: untouched by the same round (the 24h window still
 *    gates it);
 *  - re-running the sweep is a no-op — idempotent, payload stays NULL;
 *  - a GitHub redelivery of a purged delivery id is still ack'ed and
 *    dropped by the primary key (dedup keeps working with the row, and the
 *    row is exactly why the payload bytes, not the row, are what purge
 *    reclaims);
 *  - bounded growth: after the rounds, every purged row carries NULL
 *    payload — the table's total payload bytes collapse to just the rows
 *    that are still fresh.
 */
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sweepWebhookDeliveries } from "../../src/domain/automation/index.js";
import { runRetentionSweeps } from "../../src/domain/retention-sweeps.js";
import { startTestRig, type TestRig } from "./setup.js";

const WEBHOOK_SECRET = "test-webhook-secret"; // setup.ts's rig value.

/** Far in the past — before both the rig's fixed clock and Postgres now() − 24h. */
const BACKDATED = "2025-12-30T23:00:00Z";

function retentionDeps(rig: TestRig) {
  return {
    db: rig.deps.db,
    pool: rig.pool,
    objectStore: rig.objectStore,
    gitHost: rig.gitHost,
  };
}

interface DeliveryState {
  delivery_id: string;
  received_at: Date;
  processed_at: Date | null;
  purged_at: Date | null;
  payload: unknown;
}

async function deliveryState(rig: TestRig, deliveryId: string): Promise<DeliveryState> {
  const { rows } = await rig.pool.query<DeliveryState>(
    `select delivery_id, received_at, processed_at, purged_at, payload
       from webhook_deliveries where delivery_id = $1`,
    [deliveryId],
  );
  const row = rows[0];
  if (!row) throw new Error(`no webhook_deliveries row for ${deliveryId}`);
  return row;
}

/** A push event whose repo does not exist — dispatched as a no-op success by the mapping sweep. */
function pushPayload(deliveryId: string, sha: string): unknown {
  return {
    ref: "refs/heads/main",
    after: sha,
    deleted: false,
    commits: [{ modified: [".factory/pipeline.yaml"] }],
    repository: { full_name: "no-such-owner/no-such-repo" },
  };
}

/** A signed delivery POST — the real ingest path (HMAC, `X-GitHub-Delivery`). */
async function webhook(
  rig: TestRig,
  eventType: string,
  deliveryId: string,
  payload: unknown,
): Promise<Response> {
  const rawBody = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(rawBody, "utf-8").digest("hex")}`;
  return fetch(`${rig.baseUrl}/webhook/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": eventType,
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": signature,
    },
    body: rawBody,
  });
}

describe("webhook delivery retention (issue #23)", () => {
  let rig: TestRig;

  beforeAll(async () => {
    rig = await startTestRig();
  });

  afterAll(async () => {
    await rig.stop();
  });

  it("purge clears the payload of processed deliveries past 24h, keeps the rows, and leaves fresh or unmapped deliveries alone", async () => {
    const OLD_1 = "issue23-old-1";
    const OLD_2 = "issue23-old-2";
    const OLD_3 = "issue23-old-3";
    const UNPROCESSED = "issue23-old-unprocessed";
    const FRESH = "issue23-fresh";

    // Three processed deliveries past the window, one unprocessed delivery
    // of the same age, one fresh delivery (received just now, real now()).
    for (const id of [OLD_1, OLD_2, OLD_3]) {
      await rig.pool.query(
        `insert into webhook_deliveries (delivery_id, received_at, next_attempt_at, event_type, payload, processed_at)
         values ($1, $2, $2, 'push', $3, $2)`,
        [id, BACKDATED, JSON.stringify(pushPayload(id, `sha-${id}`))],
      );
    }
    await rig.pool.query(
      `insert into webhook_deliveries (delivery_id, received_at, next_attempt_at, event_type, payload)
       values ($1, $2, $2, 'push', $3)`,
      [UNPROCESSED, BACKDATED, JSON.stringify(pushPayload(UNPROCESSED, "sha-unprocessed"))],
    );
    await rig.pool.query(
      `insert into webhook_deliveries (delivery_id, received_at, next_attempt_at, event_type, payload)
       values ($1, $2, $2, 'push', $3)`,
      [FRESH, new Date(), JSON.stringify(pushPayload(FRESH, "sha-fresh"))],
    );

    // Round one: only the three processed-and-old deliveries are candidates.
    const first = await runRetentionSweeps(retentionDeps(rig), { batch: 10 });
    expect(first.webhookDeliveries).toBe(3);

    for (const id of [OLD_1, OLD_2, OLD_3]) {
      const row = await deliveryState(rig, id);
      expect(row.purged_at).not.toBeNull();
      expect(row.payload).toBeNull(); // the raw event bytes are gone…
      expect(row.processed_at).not.toBeNull();
    }
    // …but the rows themselves — the layer-1 dedup keys — survive.
    const { rows: countRows } = await rig.pool.query<{ n: number }>(
      "select count(*)::int as n from webhook_deliveries",
    );
    expect(countRows[0]!.n).toBe(5);

    // The unprocessed old delivery keeps its payload — it still needs it.
    const unmapped = await deliveryState(rig, UNPROCESSED);
    expect(unmapped.purged_at).toBeNull();
    expect(unmapped.payload).not.toBeNull();

    // The fresh delivery is untouched — the 24h window still gates it.
    const fresh = await deliveryState(rig, FRESH);
    expect(fresh.purged_at).toBeNull();
    expect(fresh.payload).not.toBeNull();

    // The mapping sweep catches the old unprocessed delivery up; a later
    // round then purges it too — its payload was never lost, never empty.
    const processed = await sweepWebhookDeliveries(rig.deps);
    expect(processed).toBe(1);
    const nowMapped = await deliveryState(rig, UNPROCESSED);
    expect(nowMapped.processed_at).not.toBeNull();
    expect(nowMapped.payload).not.toBeNull();

    const second = await runRetentionSweeps(retentionDeps(rig), { batch: 10 });
    expect(second.webhookDeliveries).toBe(1);
    const purged = await deliveryState(rig, UNPROCESSED);
    expect(purged.purged_at).not.toBeNull();
    expect(purged.payload).toBeNull();

    // The sweep is idempotent: a third round touches nothing.
    const third = await runRetentionSweeps(retentionDeps(rig), { batch: 10 });
    expect(third.webhookDeliveries).toBe(0);
  });

  it("bounded growth: the table's payload bytes collapse to only what is still fresh", async () => {
    const { rows } = await rig.pool.query<{
      purged: number;
      with_payload: number;
      payload_bytes: number;
    }>(
      `select count(*) filter (where purged_at is not null)::int as purged,
              count(*) filter (where payload is not null)::int as with_payload,
              coalesce(sum(pg_column_size(payload)), 0)::int as payload_bytes
         from webhook_deliveries`,
    );
    // Every old row is purged and payload-free; only the fresh row still
    // carries bytes, and its size is the whole table's payload footprint.
    expect(rows[0]!.purged).toBe(4);
    expect(rows[0]!.with_payload).toBe(1);
    expect(rows[0]!.payload_bytes).toBeGreaterThan(0);
  });

  it("a GitHub redelivery of a purged delivery id is still deduped by the surviving row", async () => {
    const OLD_1 = "issue23-old-1";
    const response = await webhook(rig, "push", OLD_1, pushPayload(OLD_1, "sha-redelivered"));
    expect(response.status).toBe(202);

    // The primary key still swallows the redelivery — no second row, and the
    // cleared payload is not resurrected by the conflict-do-nothing insert.
    const { rows } = await rig.pool.query<{ n: number }>(
      "select count(*)::int as n from webhook_deliveries where delivery_id = $1",
      [OLD_1],
    );
    expect(rows[0]!.n).toBe(1);
    const row = await deliveryState(rig, OLD_1);
    expect(row.payload).toBeNull();
  });
});
