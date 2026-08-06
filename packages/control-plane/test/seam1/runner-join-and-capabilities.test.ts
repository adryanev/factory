/**
 * AC1: "Join token sekali pakai ditukar jadi runner-id + secret di disk;
 * identitas ada di file itu, bukan di hostname atau IP."
 * AC2: "Kapabilitas diprobe tiap start ...; slots dan label ditulis
 * operator; hash-nya ikut heartbeat dan laporan penuh diminta saat berubah."
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestRig, type TestRig } from "./setup.js";
import { createRunnerClient } from "./fake-runner-client.js";
import { joinRunner, mintJoinToken } from "./runner-test-helpers.js";

describe("Runner protocol: /join and capabilities", () => {
  let rig: TestRig;
  let ownerCookie: string;

  beforeAll(async () => {
    rig = await startTestRig();
    ownerCookie = await rig.loginAsBreakGlass();
  });

  afterAll(async () => {
    await rig.stop();
  });

  it("exchanges a single-use join token for a runner id + secret, and a second exchange of the same token is refused", async () => {
    const token = await mintJoinToken(rig, ownerCookie);
    const client = createRunnerClient(rig.baseUrl);

    const first = await client.join(token);
    expect(first.status).toBe(200);
    const body = first.body;
    expect(body.runner_id).toMatch(/^runner_/);
    expect(body.secret).toMatch(/^rnr_/);

    const second = await client.join(token);
    expect(second.status).toBe(401); // single-use — spec: "Join token sekali pakai".
  });

  it("authenticates every subsequent call purely off the bearer secret — never off a hostname or IP", async () => {
    const { secret, client } = await joinRunner(rig, ownerCookie);

    // The only thing that identifies this Runner to the control plane is
    // the secret string — proven here by successfully heartbeating from an
    // ordinary `fetch` call that carries no host/IP-derived credential of
    // any kind, only the bearer header.
    const heartbeat = await client.heartbeat(secret);
    expect(heartbeat.status).toBe(200);

    // A syntactically similar but wrong secret is refused outright.
    const wrongSecret = await client.heartbeat(`${secret}x`);
    expect(wrongSecret.status).toBe(401);
  });

  it("rejects a request with no Authorization header at all", async () => {
    const client = createRunnerClient(rig.baseUrl);
    const response = await fetch(`${rig.baseUrl}/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ leases: [] }),
    });
    expect(response.status).toBe(401);
    void client;
  });

  it("flags caps_stale until a matching full capabilities report lands, then clears it — and re-flags on the next change", async () => {
    const { secret, client } = await joinRunner(rig, ownerCookie);

    // Freshly joined: the control plane has never recorded a caps_hash, so
    // any reported hash is "stale" (a full report is due).
    const firstHeartbeat = await client.heartbeat(secret, { caps_hash: "v1" });
    expect(firstHeartbeat.status).toBe(200);
    expect((firstHeartbeat.body as { caps_stale: boolean }).caps_stale).toBe(true);

    const report = await client.reportCapabilities(secret, {
      caps_hash: "v1",
      capabilities: { execMode: "docker", agentClis: ["claude"], cpuCount: 8, ramBytes: 34_359_738_368 },
    });
    expect(report.status).toBe(200);

    const secondHeartbeat = await client.heartbeat(secret, { caps_hash: "v1" });
    expect((secondHeartbeat.body as { caps_stale: boolean }).caps_stale).toBe(false);

    // Capabilities changed locally (e.g. a new agent CLI got installed) —
    // the new hash doesn't match what was last reported, so it's stale again.
    const thirdHeartbeat = await client.heartbeat(secret, { caps_hash: "v2" });
    expect((thirdHeartbeat.body as { caps_stale: boolean }).caps_stale).toBe(true);
  });

  it("lets an operator write slots and tags as policy, independent of anything the Runner reports", async () => {
    const { runnerId } = await joinRunner(rig, ownerCookie, { slots: 4, tags: ["docker", "linux"] });

    const [row] = await rig.pool.query<{ slots: number; tags: string[] }>(
      `select slots, tags from runners where id = $1`,
      [runnerId],
    ).then((r) => r.rows);
    expect(row?.slots).toBe(4);
    expect(row?.tags).toEqual(["docker", "linux"]);
  });
});
