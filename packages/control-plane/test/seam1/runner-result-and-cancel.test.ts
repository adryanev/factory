/**
 * AC10: "Cancel otoritatif di control plane: baris jadi `cancelled` seketika
 * dan UI berubah; `/result` yang telanjur dikirim dijawab `409`."
 * AC11: "Idempotensi `/result` bersandar pada `lease_token` — sama menjawab
 * `200` dengan hasil tercatat, berbeda menjawab `409`."
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestRig, type TestRig } from "./setup.js";
import { joinRunner, seedReadyStepRun } from "./runner-test-helpers.js";

async function addOwnerAsMember(rig: TestRig, ownerCookie: string, projectId: string): Promise<void> {
  await fetch(`${rig.baseUrl}/projects/${projectId}/members/self`, {
    method: "POST",
    headers: { cookie: ownerCookie, "x-factory-csrf": "1" },
  });
}

describe("Runner protocol: /result idempotency and cancel authority", () => {
  let rig: TestRig;
  let ownerCookie: string;

  beforeAll(async () => {
    rig = await startTestRig();
    ownerCookie = await rig.loginAsBreakGlass();
  });

  afterAll(async () => {
    await rig.stop();
  });

  it("the same lease_token replays the recorded outcome at 200; a different one is fenced with 409", async () => {
    const { secret, client } = await joinRunner(rig, ownerCookie);
    await seedReadyStepRun(rig.pool);

    const claimed = await client.claim(secret);
    const stepRun = (claimed.body as { step_run: { id: string; lease_token: string } }).step_run;

    const first = await client.result(secret, stepRun.id, {
      lease_token: stepRun.lease_token,
      outcome: "succeeded",
      ref: { branch: "run/x/step/t1-a1", sha: "cafebabe" },
      output_data: { greeting: "hi" },
    });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ outcome: "succeeded", ref: { branch: "run/x/step/t1-a1", sha: "cafebabe" } });

    // Same token, resent (the Runner's own retry after a dropped response) — replays, does not error, does not re-derive a different answer.
    const replay = await client.result(secret, stepRun.id, {
      lease_token: stepRun.lease_token,
      outcome: "succeeded",
      ref: { branch: "run/x/step/t1-a1", sha: "cafebabe" },
    });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);

    // A different token claiming to be for the same StepRun is fenced.
    const forged = await client.result(secret, stepRun.id, {
      lease_token: "not-the-real-lease-token",
      outcome: "succeeded",
    });
    expect(forged.status).toBe(409);
  });

  it("a StepRun cancelled by an operator goes cancelled immediately; a /result already in flight for it is answered 409", async () => {
    const { secret, client } = await joinRunner(rig, ownerCookie);
    const { projectId, stepRunId } = await seedReadyStepRun(rig.pool);
    await addOwnerAsMember(rig, ownerCookie, projectId);

    const claimed = await client.claim(secret);
    const stepRun = (claimed.body as { step_run: { id: string; lease_token: string } }).step_run;
    expect(stepRun.id).toBe(stepRunId);

    // Cancel lands first — authoritative immediately (row goes `cancelled`
    // synchronously, no lease/Runner round trip required).
    const cancelResponse = await fetch(`${rig.baseUrl}/step-runs/${stepRunId}/cancel`, {
      method: "POST",
      headers: { cookie: ownerCookie, "x-factory-csrf": "1" },
    });
    expect(cancelResponse.status).toBe(200);

    const row = await rig.pool.query<{ outcome: string; reason: string | null }>(
      "select outcome, reason from step_runs where id = $1",
      [stepRunId],
    );
    expect(row.rows[0]).toEqual({ outcome: "cancelled", reason: "cancelled-by-operator" });

    // The Runner's /result — already "in flight" when the cancel happened — is rejected.
    const lateResult = await client.result(secret, stepRunId, {
      lease_token: stepRun.lease_token,
      outcome: "succeeded",
    });
    expect(lateResult.status).toBe(409);

    // The row is still cancelled, not overwritten by the late result.
    const rowAfter = await rig.pool.query<{ outcome: string }>("select outcome from step_runs where id = $1", [
      stepRunId,
    ]);
    expect(rowAfter.rows[0]?.outcome).toBe("cancelled");
  });

  it("cancelling a StepRun a second time is idempotent", async () => {
    const { projectId, stepRunId } = await seedReadyStepRun(rig.pool);
    await addOwnerAsMember(rig, ownerCookie, projectId);

    const first = await fetch(`${rig.baseUrl}/step-runs/${stepRunId}/cancel`, {
      method: "POST",
      headers: { cookie: ownerCookie, "x-factory-csrf": "1" },
    });
    expect(first.status).toBe(200);
    const second = await fetch(`${rig.baseUrl}/step-runs/${stepRunId}/cancel`, {
      method: "POST",
      headers: { cookie: ownerCookie, "x-factory-csrf": "1" },
    });
    expect(second.status).toBe(200); // idempotent — a second click is not an error.
  });

  it("cancelling an already-succeeded StepRun is rejected with 400, and the outcome is left untouched", async () => {
    const { secret, client } = await joinRunner(rig, ownerCookie);
    const uniqueTag = `only-this-test-${Date.now()}`;
    const { projectId, stepRunId } = await seedReadyStepRun(rig.pool, { requiredTags: [uniqueTag] });
    await addOwnerAsMember(rig, ownerCookie, projectId);

    const claimed = await client.claim(secret, { tags: [uniqueTag] });
    const stepRun = (claimed.body as { step_run: { id: string; lease_token: string } | null }).step_run;
    expect(stepRun?.id).toBe(stepRunId);

    await client.result(secret, stepRunId, {
      lease_token: stepRun!.lease_token,
      outcome: "succeeded",
      ref: { branch: "run/x/step/t1-a1", sha: "cafebabe" },
    });

    const cancelSucceeded = await fetch(`${rig.baseUrl}/step-runs/${stepRunId}/cancel`, {
      method: "POST",
      headers: { cookie: ownerCookie, "x-factory-csrf": "1" },
    });
    expect(cancelSucceeded.status).toBe(400);

    const row = await rig.pool.query<{ outcome: string }>("select outcome from step_runs where id = $1", [
      stepRunId,
    ]);
    expect(row.rows[0]?.outcome).toBe("succeeded");
  });
});
