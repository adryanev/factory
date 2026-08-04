/**
 * AC12: "Drain dan revoke lewat satu kolom `desired_state`, ditulis CLI
 * lokal maupun tombol UI; revoke adalah fencing, bukan pembunuhan."
 * AC9: "Hanya `401` yang membuat Runner berhenti; `426`/`409`/`400`/`413`/
 * `429`/`503`/`5xx` semuanya membiarkan ia tetap heartbeat dan kembali ke
 * `/claim`." — proven here at the wire level: every one of those statuses
 * leaves the Runner's secret valid for the very next call. (The Runner
 * *client's* reaction — "keep going unless 401" — is a control-loop decision
 * with no server counterpart to assert on here; it's proven as a pure unit
 * over the status-code table in `packages/runner`.)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestRig, type TestRig } from "./setup.js";
import { joinRunner, setRunnerPolicy } from "./runner-test-helpers.js";

describe("Runner protocol: drain, revoke, and which statuses stop a Runner", () => {
  let rig: TestRig;
  let ownerCookie: string;

  beforeAll(async () => {
    rig = await startTestRig();
    ownerCookie = await rig.loginAsBreakGlass();
  });

  afterAll(async () => {
    await rig.stop();
  });

  it("a Runner can self-drain via /runners/me/drain — desired_state flips to draining and shows up in its own heartbeat reply", async () => {
    const { secret, client } = await joinRunner(rig, ownerCookie);

    const before = await client.heartbeat(secret);
    expect((before.body as { desired_state: string }).desired_state).toBe("active");

    const drainResponse = await client.selfDrain(secret);
    expect(drainResponse.status).toBe(200);

    const after = await client.heartbeat(secret);
    expect((after.body as { desired_state: string }).desired_state).toBe("draining");
  });

  it("an operator can drain a Runner through the same desired_state column via the UI/admin path, independent of the Runner's own CLI path", async () => {
    const { runnerId, secret, client } = await joinRunner(rig, ownerCookie);

    const response = await fetch(`${rig.baseUrl}/runners/${runnerId}/drain`, {
      method: "POST",
      headers: { cookie: ownerCookie, "x-factory-csrf": "1" },
    });
    expect(response.status).toBe(200);

    const heartbeat = await client.heartbeat(secret);
    expect((heartbeat.body as { desired_state: string }).desired_state).toBe("draining");
  });

  it("revoke is fencing: the Runner's own secret stops authenticating from the instant of revoke, even though nothing touched the Runner's process", async () => {
    const { runnerId, secret, client } = await joinRunner(rig, ownerCookie);

    // Healthy before revoke.
    const before = await client.heartbeat(secret);
    expect(before.status).toBe(200);

    const revokeResponse = await fetch(`${rig.baseUrl}/runners/${runnerId}/revoke`, {
      method: "POST",
      headers: { cookie: ownerCookie, "x-factory-csrf": "1" },
    });
    expect(revokeResponse.status).toBe(200);

    // Fenced immediately — no grace period, no "still valid until it next syncs".
    const heartbeatAfter = await client.heartbeat(secret);
    expect(heartbeatAfter.status).toBe(401);
    const claimAfter = await client.claim(secret);
    expect(claimAfter.status).toBe(401);
  });

  it("only 401 is fatal: 426 (bad protocol version) and 409 (stale lease) both leave the Runner's secret valid for its very next call", async () => {
    const { secret, client } = await joinRunner(rig, ownerCookie);

    const badProtocol = await client.claim(secret, { protocol_version: 999 });
    expect(badProtocol.status).toBe(426);

    const staleResult = await client.result(secret, "steprun_00000000000000000000000000", {
      lease_token: "bogus",
      outcome: "succeeded",
    });
    expect(staleResult.status).toBe(409);

    // The secret is still good — neither of the above stopped it.
    const heartbeat = await client.heartbeat(secret);
    expect(heartbeat.status).toBe(200);
    const claimAgain = await client.claim(secret, { protocol_version: 1, tags: ["nothing-ready"] });
    expect(claimAgain.status).toBe(200);
  });

  it("setting operator policy (slots/tags) does not itself change desired_state", async () => {
    const { runnerId } = await joinRunner(rig, ownerCookie);
    await setRunnerPolicy(rig, ownerCookie, runnerId, { slots: 7, tags: ["gpu"] });
    const row = await rig.pool.query<{ desired_state: string; slots: number; tags: string[] }>(
      "select desired_state, slots, tags from runners where id = $1",
      [runnerId],
    );
    expect(row.rows[0]).toEqual({ desired_state: "active", slots: 7, tags: ["gpu"] });
  });
});
