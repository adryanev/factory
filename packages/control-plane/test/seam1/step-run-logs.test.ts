/**
 * The log surface (issue #7): live-tail + archive through one endpoint,
 * byte-free. Covers:
 *  - dedup of chunk metadata at the primary key `(step_run_id, attempt, seq)`
 *    via `ON CONFLICT DO NOTHING` — not in application code;
 *  - attempt isolation — a dead attempt's chunks are never overwritten by the
 *    next attempt's (spec: "Kunci (StepRun, attempt)");
 *  - live-tail long-poll returning a list of presigned GETs (never bytes),
 *    and the browser-side peer-to-peer round trip against the (fake) object
 *    store;
 *  - archive: the same endpoint from offset zero;
 *  - the one-tab-one-hanging-connection cap;
 *  - Project-membership gating (403) and the 401 for an anonymous caller.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestRig, type TestRig } from "./setup.js";
import { joinRunner, realIdGenerator, seedReadyStepRun } from "./runner-test-helpers.js";
import type { RunnerClient } from "./fake-runner-client.js";

async function addOwnerAsMember(rig: TestRig, ownerCookie: string, projectId: string): Promise<void> {
  const response = await fetch(`${rig.baseUrl}/projects/${projectId}/members/self`, {
    method: "POST",
    headers: { cookie: ownerCookie, "x-factory-csrf": "1" },
  });
  if (response.status !== 200) {
    throw new Error(`self-add failed: ${response.status} ${await response.text()}`);
  }
}

interface Claimed {
  stepRunId: string;
  leaseToken: string;
  secret: string;
  client: RunnerClient;
}

async function claimFirstStepRun(rig: TestRig, ownerCookie: string): Promise<Claimed> {
  const { secret, client } = await joinRunner(rig, ownerCookie);
  const { projectId, stepRunId } = await seedReadyStepRun(rig.pool, {}, realIdGenerator());
  await addOwnerAsMember(rig, ownerCookie, projectId);
  const claimed = await client.claim(secret);
  const stepRun = (claimed.body as { step_run: { id: string; lease_token: string } }).step_run;
  return { stepRunId, leaseToken: stepRun.lease_token, secret, client };
}

async function recordChunk(
  rig: TestRig,
  claimed: Claimed,
  chunk: { attempt: number; seq: number; blob_key: string; byte_offset: number; size: number },
): Promise<void> {
  const response = await claimed.client.logChunks(claimed.secret, claimed.stepRunId, {
    lease_token: claimed.leaseToken,
    chunks: [chunk],
  });
  expect(response.status).toBe(200);
}

/** The Runner's full per-chunk flow: mint a presigned PUT for `key`, PUT the bytes to it, then record the metadata. */
async function uploadChunk(
  rig: TestRig,
  claimed: Claimed,
  key: string,
  blobKey: string,
  body: string,
  attempt: number,
  seq: number,
): Promise<void> {
  const grants = await claimed.client.uploads(claimed.secret, claimed.stepRunId, {
    lease_token: claimed.leaseToken,
    requests: [{ key, kind: "log" }],
  });
  expect(grants.status).toBe(200);
  const uploadUrl = (grants.body as { grants: { upload_url: string }[] }).grants[0]!.upload_url;
  rig.objectStore.putFromUrl(uploadUrl, body);
  await recordChunk(rig, claimed, {
    attempt,
    seq,
    blob_key: blobKey,
    byte_offset: 0,
    size: body.length,
  });
}

async function liveTail(rig: TestRig, cookie: string, stepRunId: string, query = ""): Promise<Response> {
  return fetch(`${rig.baseUrl}/step-runs/${stepRunId}/log${query}`, { headers: { cookie } });
}

describe("Log surface: chunks, live-tail, archive", () => {
  let rig: TestRig;
  let ownerCookie: string;

  beforeAll(async () => {
    rig = await startTestRig();
    ownerCookie = await rig.loginAsBreakGlass();
  });

  afterAll(async () => {
    await rig.stop();
  });

  it("dedup lives in the primary key (step_run_id, attempt, seq) with ON CONFLICT DO NOTHING — a resend is 200, not a second row", async () => {
    const claimed = await claimFirstStepRun(rig, ownerCookie);
    const chunk = {
      attempt: 1,
      seq: 0,
      blob_key: `log/${claimed.stepRunId}/1/0`,
      byte_offset: 0,
      size: 12,
    };
    await recordChunk(rig, claimed, chunk);
    // Resend identical — the Runner's own retry after a dropped response.
    await recordChunk(rig, claimed, chunk);
    // A resend with a *different* blob_key for the same (attempt, seq) must
    // also be DO NOTHING — the first metadata wins; no second row, no 409.
    await recordChunk(rig, claimed, { ...chunk, blob_key: "log/somewhere-else/1/0" });

    const { rows } = await rig.pool.query<{ attempt: number; seq: number; blob_key: string }>(
      "select attempt, seq, blob_key from log_chunks where step_run_id = $1",
      [claimed.stepRunId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ attempt: 1, seq: 0, blob_key: `log/${claimed.stepRunId}/1/0` });
  });

  it("a dead attempt's chunks are never overwritten by the next attempt — attempt isolation in the primary key and in live-tail", async () => {
    const claimed = await claimFirstStepRun(rig, ownerCookie);

    // Attempt 1 runs and dies, leaving chunks seq 0..1.
    await uploadChunk(rig, claimed, "1/0", `log/${claimed.stepRunId}/1/0`, "attempt-one-line-a\n", 1, 0);
    await uploadChunk(rig, claimed, "1/1", `log/${claimed.stepRunId}/1/1`, "attempt-one-line-b\n", 1, 1);

    // The next attempt restarts seq at 0 — same (step_run, seq), different attempt.
    await uploadChunk(rig, claimed, "2/0", `log/${claimed.stepRunId}/2/0`, "attempt-two-line-a\n", 2, 0);

    const { rows } = await rig.pool.query<{ attempt: number; seq: number }>(
      "select attempt, seq from log_chunks where step_run_id = $1 order by attempt, seq",
      [claimed.stepRunId],
    );
    expect(rows).toEqual([
      { attempt: 1, seq: 0 },
      { attempt: 1, seq: 1 },
      { attempt: 2, seq: 0 },
    ]);

    // Reading attempt 1 is unaffected by attempt 2's same-seq chunk.
    const a1 = await liveTail(rig, ownerCookie, claimed.stepRunId, "?attempt=1&offset=0");
    const a1Body = (await a1.json()) as { chunks: { getUrl: string }[]; attempt: number };
    expect(a1Body.attempt).toBe(1);
    expect(a1Body.chunks).toHaveLength(2);
    const a1Text = a1Body.chunks.map((chunk) => rig.objectStore.getFromUrl(chunk.getUrl)).join("");
    expect(a1Text).toBe("attempt-one-line-a\nattempt-one-line-b\n");

    const a2 = await liveTail(rig, ownerCookie, claimed.stepRunId, "?attempt=2&offset=0");
    const a2Body = (await a2.json()) as { chunks: { getUrl: string }[]; attempt: number };
    expect(a2Body.attempt).toBe(2);
    expect(a2Body.chunks).toHaveLength(1);
    expect(rig.objectStore.getFromUrl(a2Body.chunks[0]!.getUrl)).toBe("attempt-two-line-a\n");
  });

  it("live-tail returns a list of presigned GETs — the browser reads the bytes from the object store, the control plane never saw them", async () => {
    const claimed = await claimFirstStepRun(rig, ownerCookie);

    // The full Runner per-chunk flow: mint PUT -> PUT bytes -> record metadata.
    await uploadChunk(rig, claimed, "1/0", `log/${claimed.stepRunId}/1/0`, "hello from the runner\n", 1, 0);

    // The browser long-polls the same endpoint from offset 0 and gets URLs, not bytes.
    const tail = await liveTail(rig, ownerCookie, claimed.stepRunId, "?attempt=1&offset=0");
    expect(tail.status).toBe(200);
    const body = (await tail.json()) as {
      chunks: { seq: number; size: number; getUrl: string; expiresAt: string }[];
      nextOffset: number;
      ended: boolean;
    };
    expect(body.chunks).toHaveLength(1);
    expect(body.chunks[0]).toMatchObject({ seq: 0, size: 22 });
    expect(body.nextOffset).toBe(1);
    expect(body.ended).toBe(false);

    // The GET URL reads back exactly the bytes PUT to the object store — the
    // whole round trip is peer-to-peer.
    expect(rig.objectStore.getFromUrl(body.chunks[0]!.getUrl)).toBe("hello from the runner\n");

    // The minted GET is the exact URL the control plane handed out, and it
    // expires 5 minutes after minting (spec: "Presigned GET berumur 5 menit").
    expect(body.chunks[0]!.expiresAt).toBe("2026-01-01T00:05:00.000Z");
    const mintedGets = rig.objectStore.mintedGets;
    expect(mintedGets).toContain(`log/${claimed.stepRunId}/1/0`);
  });

  it("a running StepRun with no new chunks holds (empty reply, not ended); an ended StepRun reads as archive from offset zero", async () => {
    const claimed = await claimFirstStepRun(rig, ownerCookie);
    await uploadChunk(rig, claimed, "1/0", `log/${claimed.stepRunId}/1/0`, "first chunk\n", 1, 0);

    // StepRun still running: the browser asks from offset 1 (nextOffset of the
    // previous reply) and the long-poll holds until the injected 400ms hold
    // elapses with nothing new — empty chunks, not ended.
    const held = await liveTail(rig, ownerCookie, claimed.stepRunId, "?attempt=1&offset=1");
    const heldBody = (await held.json()) as { chunks: unknown[]; nextOffset: number; ended: boolean };
    expect(heldBody.chunks).toEqual([]);
    expect(heldBody.nextOffset).toBe(1);
    expect(heldBody.ended).toBe(false);

    // The StepRun ends; the archive read (offset 0) returns everything at once.
    const result = await claimed.client.result(claimed.secret, claimed.stepRunId, {
      lease_token: claimed.leaseToken,
      outcome: "succeeded",
      ref: { branch: "run/x/step/t1-a1", sha: "cafebabe" },
    });
    expect(result.status).toBe(200);

    const archive = await liveTail(rig, ownerCookie, claimed.stepRunId, "?attempt=1&offset=0");
    const archiveBody = (await archive.json()) as { chunks: { seq: number }[]; ended: boolean };
    expect(archiveBody.chunks.map((chunk) => chunk.seq)).toEqual([0]);
    expect(archiveBody.ended).toBe(true);
  });

  it("one tab = one hanging connection: over the cap answers 503 + Retry-After", async () => {
    const capped = await startTestRig({ maxHangingLiveTails: 1, liveTailHoldMs: 400 });
    try {
      const owner = await capped.loginAsBreakGlass();
      const claimed = await claimFirstStepRun(capped, owner);

      const first = liveTail(capped, owner, claimed.stepRunId, "?attempt=1&offset=0");
      // Give the first request time to grab the single slot.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const second = await liveTail(capped, owner, claimed.stepRunId, "?attempt=1&offset=0");
      expect(second.status).toBe(503);
      expect(second.headers.get("retry-after")).toBe("5");

      const firstResolved = await first;
      expect(firstResolved.status).toBe(200);
    } finally {
      await capped.stop();
    }
  });

  it("Project membership gates the log read: 401 anonymous, 403 for a non-member", async () => {
    const claimed = await claimFirstStepRun(rig, ownerCookie);

    const anon = await fetch(`${rig.baseUrl}/step-runs/${claimed.stepRunId}/log?attempt=1&offset=0`);
    expect(anon.status).toBe(401);

    const outsider = await rig.loginAsGithub({
      githubUserId: 7777,
      githubLogin: "outsider",
      name: null,
      avatarUrl: null,
    });
    const denied = await liveTail(rig, outsider, claimed.stepRunId, "?attempt=1&offset=0");
    expect(denied.status).toBe(403);
  });

  it("a nonexistent step run id is a 404 for the browser surface", async () => {
    const response = await fetch(`${rig.baseUrl}/step-runs/steprun_nope/log?attempt=1&offset=0`, {
      headers: { cookie: ownerCookie },
    });
    expect(response.status).toBe(404);
  });
});
