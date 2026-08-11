/**
 * Issue #33 — the Runner pool surface the SPA renders: every registered
 * Runner with its facts (protocol version, release version, last heartbeat)
 * and its live lease count. The pool is org-wide, so the gate is org
 * `owner`, not Project `admin`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestRig, type TestRig } from "./setup.js";
import { joinRunner, seedReadyStepRun } from "./runner-test-helpers.js";

interface PoolRow {
  id: string;
  desiredState: string;
  tags: string[];
  slots: number;
  protocolVersion: number | null;
  releaseVersion: string | null;
  lastHeartbeatAt: string | null;
  activeLeases: number;
}

describe("Runner pool list (issue #33)", () => {
  let rig: TestRig;
  let ownerCookie: string;

  beforeAll(async () => {
    rig = await startTestRig();
    ownerCookie = await rig.loginAsBreakGlass();
  });

  afterAll(async () => {
    await rig.stop();
  });

  it("lists every Runner with its facts and its live lease count", async () => {
    const { runnerId, secret, client } = await joinRunner(rig, ownerCookie);
    await client.heartbeat(secret);
    await client.reportCapabilities(secret, {
      caps_hash: "hash-1",
      capabilities: { exec: "host" },
      release_version: "v0.0.1",
    });

    // Lease one ready StepRun to this Runner, like /claim would have.
    const { stepRunId } = await seedReadyStepRun(rig.pool);
    await rig.pool.query(
      "update step_runs set leased_by = $1, lease_expires_at = now() + interval '60 seconds' where id = $2",
      [runnerId, stepRunId],
    );

    const response = await fetch(`${rig.baseUrl}/runners`, { headers: { cookie: ownerCookie } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { runners: PoolRow[] };
    const row = body.runners.find((runner) => runner.id === runnerId);
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      desiredState: "active",
      slots: 10,
      tags: [],
      releaseVersion: "v0.0.1",
      activeLeases: 1,
    });
    expect(row!.lastHeartbeatAt).not.toBeNull();
  });

  it("answers 401 without a session", async () => {
    const response = await fetch(`${rig.baseUrl}/runners`);
    expect(response.status).toBe(401);
  });

  it("answers 403 for a logged-in non-owner", async () => {
    const memberCookie = await rig.loginAsGithub({
      githubUserId: 910_001,
      githubLogin: "member-910001",
      name: null,
      avatarUrl: null,
    });
    const response = await fetch(`${rig.baseUrl}/runners`, { headers: { cookie: memberCookie } });
    expect(response.status).toBe(403);
  });
});
