/**
 * AC3: "`/claim` long-poll dengan durasi tahan diacak server 20-30 detik;
 * test membuktikan kolam yang datang bersamaan pecah dalam satu siklus."
 * AC8: "`/heartbeat` selalu diterima walau protokol di luar rentang;
 * `/claim` menjawab 426."
 * AC9 (server side of it): every non-401 status still comes back as a
 * normal HTTP response the Runner can act on, never a dropped connection.
 * AC13: "Batas 2000 koneksi menggantung per instance, di atasnya 503 +
 * Retry-After."
 *
 * The actual claim query (FIFO, tag containment, the slots fence,
 * `FOR UPDATE SKIP LOCKED` under concurrency) is proven by
 * `test/sql/claim-step-run.test.ts` against `claim_step_run.sql` directly —
 * this file only proves the HTTP shell around it: the long-poll, the
 * protocol-version gate, and the connection cap.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestRig, type TestRig } from "./setup.js";
import { joinRunner, seedReadyStepRun } from "./runner-test-helpers.js";

describe("Runner protocol: /claim", () => {
  let rig: TestRig;
  let ownerCookie: string;

  beforeAll(async () => {
    rig = await startTestRig({ claimHoldRangeMs: { min: 150, max: 400 } });
    ownerCookie = await rig.loginAsBreakGlass();
  });

  afterAll(async () => {
    await rig.stop();
  });

  it("claims a ready StepRun immediately when one is available, over real HTTP", async () => {
    const { secret, client } = await joinRunner(rig, ownerCookie);
    const { stepRunId } = await seedReadyStepRun(rig.pool);

    const started = Date.now();
    const { status, body } = await client.claim(secret);
    expect(status).toBe(200);
    expect((body as { step_run: { id: string } | null }).step_run?.id).toBe(stepRunId);
    // Doesn't wait out the long-poll hold when work is immediately available.
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("returns step_run: null, not an error, when the hold elapses with nothing to claim", async () => {
    const { secret, client } = await joinRunner(rig, ownerCookie);
    const { status, body } = await client.claim(secret, { tags: ["nothing-matches-this"] });
    expect(status).toBe(200);
    expect((body as { step_run: unknown }).step_run).toBeNull();
  });

  it("a herd of Runners arriving together gets spread across the hold window, not all released at the exact same instant", async () => {
    const runners = await Promise.all(Array.from({ length: 10 }, () => joinRunner(rig, ownerCookie)));

    const start = Date.now();
    const elapsedTimes = await Promise.all(
      runners.map(async ({ secret, client }) => {
        await client.claim(secret, { tags: ["nothing-ready-for-this-tag"] });
        return Date.now() - start;
      }),
    );

    // If the hold duration were fixed (not randomized), every response
    // would land within a few ms of each other. Randomized server-side over
    // [150, 400)ms, ten independent draws should spread across a
    // meaningfully wide sub-window instead of clustering at one point.
    const spread = Math.max(...elapsedTimes) - Math.min(...elapsedTimes);
    expect(spread).toBeGreaterThan(50);
  });

  it("answers 426 for a protocol version outside the supported range, without waiting out the long-poll hold", async () => {
    const { secret, client } = await joinRunner(rig, ownerCookie);
    const started = Date.now();
    const { status } = await client.claim(secret, { protocol_version: 99 });
    expect(status).toBe(426);
    expect(Date.now() - started).toBeLessThan(500); // gate happens before the poll loop, not after it times out.
  });

  it("/heartbeat is always 200 even for a Runner reporting an out-of-range protocol version, and reports the supported range", async () => {
    const { secret, client } = await joinRunner(rig, ownerCookie);
    const response = await fetch(`${rig.baseUrl}/heartbeat`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ leases: [], protocol_version: 99 }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { protocol: { min: number; max: number } };
    expect(body.protocol).toEqual({ min: 1, max: 1 });
  });

  describe("connection cap", () => {
    let cappedRig: TestRig;
    let cappedOwnerCookie: string;

    beforeAll(async () => {
      cappedRig = await startTestRig({ claimHoldRangeMs: { min: 2000, max: 2500 }, maxHangingClaims: 2 });
      cappedOwnerCookie = await cappedRig.loginAsBreakGlass();
    });

    afterAll(async () => {
      await cappedRig.stop();
    });

    it("answers 503 with Retry-After once the hanging-connection cap is reached, while callers under the cap keep long-polling normally", async () => {
      const runnerA = await joinRunner(cappedRig, cappedOwnerCookie);
      const runnerB = await joinRunner(cappedRig, cappedOwnerCookie);
      const runnerC = await joinRunner(cappedRig, cappedOwnerCookie);

      // Two occupy the cap's two slots with a long hold; give them a moment
      // to actually be hanging before the third arrives.
      const hangingA = runnerA.client.claim(runnerA.secret, { tags: ["never-matches"] });
      const hangingB = runnerB.client.claim(runnerB.secret, { tags: ["never-matches"] });
      await new Promise((resolve) => setTimeout(resolve, 100));

      const overCap = await runnerC.client.claim(runnerC.secret, { tags: ["never-matches"] });
      expect(overCap.status).toBe(503);
      expect(overCap.headers.get("retry-after")).toBeTruthy();

      const [resultA, resultB] = await Promise.all([hangingA, hangingB]);
      expect(resultA.status).toBe(200);
      expect(resultB.status).toBe(200);
    });
  });
});
