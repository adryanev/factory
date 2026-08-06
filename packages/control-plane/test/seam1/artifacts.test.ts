/**
 * The artifact surface (issue #10): the upload-before-record commit point,
 * the quota enforced at URL-mint time, grant-batch replacement, slug keys,
 * and Project-membership reads. Seam 1 throughout — a Runner is an ordinary
 * HTTP client, a browser is an ordinary fetch, and the object store is the
 * in-memory fake (`putFromUrl`/`getFromUrl`), so the peer-to-peer round
 * trips are provable without Garage.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestRig, type TestRig } from "./setup.js";
import { joinRunner, realIdGenerator, seedReadyStepRun } from "./runner-test-helpers.js";
import { seedRunFixture, seedStepRun } from "../sql/seed.js";
import { testIdGenerator } from "../sql/db-rig.js";
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

async function claimFirstStepRun(
  rig: TestRig,
  ownerCookie: string,
  options: { selfAddOwner?: boolean } = {},
): Promise<Claimed> {
  const { secret, client } = await joinRunner(rig, ownerCookie);
  const { projectId, stepRunId } = await seedReadyStepRun(rig.pool, {}, realIdGenerator());
  if (options.selfAddOwner !== false) {
    await addOwnerAsMember(rig, ownerCookie, projectId);
  }
  const claimed = await client.claim(secret);
  const stepRun = (claimed.body as { step_run: { id: string; lease_token: string } }).step_run;
  return { stepRunId, leaseToken: stepRun.lease_token, secret, client };
}

interface ArtifactWire {
  key: string;
  size_bytes: number;
  body: string;
  kind?: string;
  content_type?: string;
}

/** The Runner's per-batch artifact flow: mint all artifacts in ONE /uploads call, PUT each to its grant. */
async function uploadBatch(
  rig: TestRig,
  claimed: Claimed,
  artifacts: ArtifactWire[],
): Promise<{ key: string; blob_key: string; upload_url: string }[]> {
  const response = await claimed.client.uploads(claimed.secret, claimed.stepRunId, {
    lease_token: claimed.leaseToken,
    requests: artifacts.map((artifact) => ({ key: artifact.key, kind: "artifact", size_bytes: artifact.size_bytes })),
  });
  expect(response.status).toBe(200);
  const grants = (response.body as { grants: { key: string; blob_key: string; upload_url: string }[] }).grants;
  expect(grants).toHaveLength(artifacts.length);
  grants.forEach((grant, index) => rig.objectStore.putFromUrl(grant.upload_url, artifacts[index]!.body));
  return grants;
}

/** The turn's final request: metadata rides /result, exactly the artifacts that uploaded. */
async function succeedWithArtifacts(
  claimed: Claimed,
  artifacts: { key: string; kind: string; content_type: string; size_bytes: number }[],
): Promise<ReturnType<RunnerClient["result"]>> {
  return claimed.client.result(claimed.secret, claimed.stepRunId, {
    lease_token: claimed.leaseToken,
    outcome: "succeeded",
    ref: { branch: "run/x/step/t1-a1", sha: "cafebabe" },
    ...(artifacts.length > 0 ? { artifacts } : {}),
  });
}

const GIB = 1024 * 1024 * 1024;

describe("Artifacts: upload-before-record, quota, replacement, reads", () => {
  let rig: TestRig;
  let ownerCookie: string;

  beforeAll(async () => {
    rig = await startTestRig();
    ownerCookie = await rig.loginAsBreakGlass();
  });

  afterAll(async () => {
    await rig.stop();
  });

  it("AC4/AC6/AC7/AC8 — mint → PUT → /result rides the metadata; the blob is where the bytes live", async () => {
    const claimed = await claimFirstStepRun(rig, ownerCookie);
    const diffText = "diff --git a/x b/x\n+built\n";
    const [grant] = await uploadBatch(rig, claimed, [{ key: "diff", size_bytes: diffText.length, body: diffText }]);
    expect(grant).toMatchObject({ key: "diff", blob_key: `artifact/${claimed.stepRunId}/diff` });

    const result = await succeedWithArtifacts(claimed, [
      { key: "diff", kind: "diff", content_type: "text/x-diff", size_bytes: diffText.length },
    ]);
    expect(result.status).toBe(200);

    const { rows } = await rig.pool.query<{
      id: string;
      step_run_id: string;
      key: string;
      kind: string;
      content_type: string;
      blob_key: string;
      size_bytes: number;
    }>(
      "select id, step_run_id, key, kind, content_type, blob_key, cast(size_bytes as integer) as size_bytes from artifacts where step_run_id = $1",
      [claimed.stepRunId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      step_run_id: claimed.stepRunId,
      key: "diff",
      kind: "diff",
      content_type: "text/x-diff",
      blob_key: `artifact/${claimed.stepRunId}/diff`,
      size_bytes: diffText.length,
    });

    // The web surface lists metadata, then mints a presigned GET that reads
    // the exact bytes back — the control plane never saw them (AC7).
    const list = await fetch(`${rig.baseUrl}/step-runs/${claimed.stepRunId}/artifacts`, {
      headers: { cookie: ownerCookie },
    });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { artifacts: { id: string; key: string }[] };
    expect(listBody.artifacts).toHaveLength(1);
    expect(listBody.artifacts[0]).toMatchObject({ key: "diff" });

    const read = await fetch(`${rig.baseUrl}/artifacts/${listBody.artifacts[0]!.id}`, {
      headers: { cookie: ownerCookie },
    });
    expect(read.status).toBe(200);
    const readBody = (await read.json()) as { getUrl: string; expiresAt: string; sizeBytes: number };
    expect(rig.objectStore.getFromUrl(readBody.getUrl)).toBe(diffText);
    expect(readBody.expiresAt).toBe("2026-01-01T00:05:00.000Z"); // 5-minute presigned lifetime.
  });

  it("AC2 — a re-request replaces the previous grant batch rather than adding to it", async () => {
    const claimed = await claimFirstStepRun(rig, ownerCookie);
    await uploadBatch(rig, claimed, [{ key: "a", size_bytes: 10, body: "aaaa" }]);
    await uploadBatch(rig, claimed, [{ key: "b", size_bytes: 10, body: "bbbb" }]);

    // Only the second batch survives in the grants table.
    const { rows } = await rig.pool.query<{ key: string; kind: string }>(
      "select key, kind from step_run_upload_grants where step_run_id = $1 order by key",
      [claimed.stepRunId],
    );
    expect(rows).toEqual([{ key: "b", kind: "artifact" }]);

    // Recording an artifact from the superseded batch is refused.
    const stale = await succeedWithArtifacts(claimed, [
      { key: "a", kind: "diff", content_type: "text/x-diff", size_bytes: 10 },
    ]);
    expect(stale.status).toBe(400);
    expect((stale.body as unknown as { code: string }).code).toBe("artifact_not_granted");

    // The current batch's artifact records fine.
    const current = await succeedWithArtifacts(claimed, [
      { key: "b", kind: "diff", content_type: "text/x-diff", size_bytes: 10 },
    ]);
    expect(current.status).toBe(200);
  });

  it("AC3 — quota is rejected at URL-mint time, and repeated requests cannot drift past it", async () => {
    const claimed = await claimFirstStepRun(rig, ownerCookie);

    // Per-artifact: 1 GiB + 1 byte is refused before any URL is returned.
    const tooBig = await claimed.client.uploads(claimed.secret, claimed.stepRunId, {
      lease_token: claimed.leaseToken,
      requests: [{ key: "big", kind: "artifact", size_bytes: GIB + 1 }],
    });
    expect(tooBig.status).toBe(400);
    expect((tooBig.body as unknown as { code: string }).code).toBe("artifact_too_large");

    // Per-StepRun: 5 GiB + 1 byte across one batch is refused.
    const overBatch = await claimed.client.uploads(claimed.secret, claimed.stepRunId, {
      lease_token: claimed.leaseToken,
      requests: Array.from({ length: 5 }, (_, index) => ({ key: `k${index}`, kind: "artifact", size_bytes: GIB }) as const).concat([
        { key: "k5", kind: "artifact", size_bytes: 1 },
      ]),
    });
    expect(overBatch.status).toBe(400);
    expect((overBatch.body as unknown as { code: string }).code).toBe("artifact_quota_exceeded");

    // Drift: two 5 GiB batches both mint fine (each replaces the other), but
    // only the current one can be recorded — the cumulative total can never
    // exceed the 5 GiB quota no matter how many times /uploads is repeated.
    await uploadBatch(
      rig,
      claimed,
      Array.from({ length: 5 }, (_, index) => ({ key: `old${index}`, size_bytes: GIB, body: "x" })),
    );
    const second = await claimed.client.uploads(claimed.secret, claimed.stepRunId, {
      lease_token: claimed.leaseToken,
      requests: Array.from({ length: 5 }, (_, index) => ({ key: `new${index}`, kind: "artifact", size_bytes: GIB }) as const),
    });
    expect(second.status).toBe(200);
    const stale = await succeedWithArtifacts(
      claimed,
      Array.from({ length: 5 }, (_, index) => ({
        key: `old${index}`,
        kind: "diff",
        content_type: "text/x-diff",
        size_bytes: GIB,
      })),
    );
    expect(stale.status).toBe(400);
    expect((stale.body as unknown as { code: string }).code).toBe("artifact_not_granted");

    // And a recorded size that exceeds what was declared at mint time is refused too.
    await uploadBatch(rig, claimed, [{ key: "sneaky", size_bytes: 10, body: "0123456789" }]);
    const oversized = await succeedWithArtifacts(claimed, [
      { key: "sneaky", kind: "diff", content_type: "text/x-diff", size_bytes: 10_000 },
    ]);
    expect(oversized.status).toBe(400);
    expect((oversized.body as unknown as { code: string }).code).toBe("artifact_size_exceeds_grant");
  });

  it("AC1 — immutable, one artifact per (StepRun, key), no version table; history is a per-key query ordered by turn", async () => {
    // Two turns of the same Step are two StepRun rows (natural key includes turn).
    const ids = testIdGenerator();
    const fixture = await seedRunFixture(rig.pool, ids);
    const runner = await joinRunner(rig, ownerCookie);
    const projectId = fixture.projectId;
    await addOwnerAsMember(rig, ownerCookie, projectId);

    const turn1Id = await seedStepRun(rig.pool, ids, {
      runId: fixture.runId,
      repositoryId: fixture.repositoryId,
      stepKey: "write",
      turn: 1,
      readyAt: new Date("2026-01-01T00:00:01.000Z"),
    });
    const turn2Id = await seedStepRun(rig.pool, ids, {
      runId: fixture.runId,
      repositoryId: fixture.repositoryId,
      stepKey: "write",
      turn: 2,
      readyAt: new Date("2026-01-01T00:00:02.000Z"),
    });

    const claimTurn = async (stepRunId: string) => {
      const claimed = await runner.client.claim(runner.secret);
      const stepRun = (claimed.body as { step_run: { id: string; lease_token: string } }).step_run;
      expect(stepRun.id).toBe(stepRunId);
      const claimedCtx = { stepRunId, leaseToken: stepRun.lease_token, secret: runner.secret, client: runner.client };
      await uploadBatch(rig, claimedCtx, [{ key: "prd", size_bytes: 5, body: "v1" }]);
      const result = await succeedWithArtifacts(claimedCtx, [
        { key: "prd", kind: "document", content_type: "text/markdown", size_bytes: 5 },
      ]);
      expect(result.status).toBe(200);
    };
    await claimTurn(turn1Id);
    await claimTurn(turn2Id);

    // Two rows, one per StepRun — the same key, never overwritten.
    const { rows } = await rig.pool.query<{ step_run_id: string; key: string }>(
      `select a.step_run_id, a.key
       from artifacts a join step_runs sr on sr.id = a.step_run_id
       where sr.run_id = $1 order by a.step_run_id`,
      [fixture.runId],
    );
    expect(rows).toEqual([
      { step_run_id: turn1Id, key: "prd" },
      { step_run_id: turn2Id, key: "prd" },
    ]);

    // "Riwayat PRD" = a per-key query joined to step_runs, ordered by turn.
    const history = await rig.pool.query<{ turn: number }>(
      `select sr.turn from artifacts a join step_runs sr on sr.id = a.step_run_id
       where a.key = 'prd' and sr.run_id = $1 order by sr.turn`,
      [fixture.runId],
    );
    expect(history.rows.map((row) => row.turn)).toEqual([1, 2]);

    // Two keys in one batch that normalize to the same slug are refused up front.
    const dupClaim = await claimFirstStepRun(rig, ownerCookie);
    const dup = await dupClaim.client.uploads(dupClaim.secret, dupClaim.stepRunId, {
      lease_token: dupClaim.leaseToken,
      requests: [
        { key: "prd", kind: "artifact", size_bytes: 1 },
        { key: "PRD", kind: "artifact", size_bytes: 1 },
      ],
    });
    expect(dup.status).toBe(400);
    expect((dup.body as unknown as { code: string }).code).toBe("artifact_key_conflict");
  });

  it("AC8 — a reported key is stored under its normalized slug", async () => {
    const claimed = await claimFirstStepRun(rig, ownerCookie);
    const [grant] = await uploadBatch(rig, claimed, [{ key: "My Report.md", size_bytes: 4, body: "abcd" }]);
    expect(grant).toMatchObject({ key: "my-report.md", blob_key: `artifact/${claimed.stepRunId}/my-report.md` });

    const result = await succeedWithArtifacts(claimed, [
      { key: "my-report.md", kind: "document", content_type: "text/markdown", size_bytes: 4 },
    ]);
    expect(result.status).toBe(200);
    const { rows } = await rig.pool.query<{ key: string }>("select key from artifacts where step_run_id = $1", [
      claimed.stepRunId,
    ]);
    expect(rows).toEqual([{ key: "my-report.md" }]);
  });

  it("AC9 — reads require Project membership; the org owner is not automatically a member", async () => {
    const claimed = await claimFirstStepRun(rig, ownerCookie, { selfAddOwner: false });
    await uploadBatch(rig, claimed, [{ key: "diff", size_bytes: 4, body: "abcd" }]);
    await succeedWithArtifacts(claimed, [
      { key: "diff", kind: "diff", content_type: "text/x-diff", size_bytes: 4 },
    ]);
    const { rows } = await rig.pool.query<{ id: string }>("select id from artifacts where step_run_id = $1", [
      claimed.stepRunId,
    ]);
    const artifactId = rows[0]!.id;

    // The org owner (break-glass) is NOT a Project member until it self-adds.
    const ownerDenied = await fetch(`${rig.baseUrl}/step-runs/${claimed.stepRunId}/artifacts`, {
      headers: { cookie: ownerCookie },
    });
    expect(ownerDenied.status).toBe(403);

    const anonymous = await fetch(`${rig.baseUrl}/step-runs/${claimed.stepRunId}/artifacts`);
    expect(anonymous.status).toBe(401);

    const outsider = await rig.loginAsGithub({
      githubUserId: 7777,
      githubLogin: "outsider",
      name: null,
      avatarUrl: null,
    });
    const outsiderDenied = await fetch(`${rig.baseUrl}/artifacts/${artifactId}`, {
      headers: { cookie: outsider },
    });
    expect(outsiderDenied.status).toBe(403);
    expect((await outsiderDenied.json() as { code: string }).code).toBe("forbidden_not_project_member");

    // The org owner is not a member, and there is no superuser back door —
    // adding itself as a Project member (the audited step the spec names) is
    // what unlocks the read.
    const denied = await fetch(`${rig.baseUrl}/artifacts/${artifactId}`, { headers: { cookie: ownerCookie } });
    expect(denied.status).toBe(403);

    const projectRow = await rig.pool.query<{ project_id: string }>(
      "select r.project_id from artifacts a join step_runs sr on sr.id = a.step_run_id join runs r on r.id = sr.run_id where a.id = $1",
      [artifactId],
    );
    await addOwnerAsMember(rig, ownerCookie, projectRow.rows[0]!.project_id);

    const read = await fetch(`${rig.baseUrl}/artifacts/${artifactId}`, { headers: { cookie: ownerCookie } });
    expect(read.status).toBe(200);
    const body = (await read.json()) as { getUrl: string };
    expect(rig.objectStore.getFromUrl(body.getUrl)).toBe("abcd");
  });

  it("a failed /result records nothing — the turn 'seolah tidak pernah terjadi'", async () => {
    const claimed = await claimFirstStepRun(rig, ownerCookie);
    const result = await claimed.client.result(claimed.secret, claimed.stepRunId, {
      lease_token: claimed.leaseToken,
      outcome: "failed",
      reason: "output-invalid",
      artifacts: [{ key: "diff", kind: "diff", content_type: "text/x-diff", size_bytes: 4 }],
    });
    expect(result.status).toBe(200);
    const { rows } = await rig.pool.query<{ id: string }>("select id from artifacts where step_run_id = $1", [
      claimed.stepRunId,
    ]);
    expect(rows).toHaveLength(0);
  });
});
