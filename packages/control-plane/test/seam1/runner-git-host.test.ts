/**
 * Issue #6's control-plane half of "Git sebagai bus": the installation-token
 * minting at `/claim` (spec: "token di-mint dua kali per giliran ... dengan
 * repository_ids sempit dan contents:write saja"), the `/result` invariant
 * pair (AC2 "StepRun `succeeded` ada ⇒ ref ada", AC3 "giliran gagal memakai
 * endpoint yang sama dengan outcome: failed + reason"), and the `exec:host`
 * Project-permission gate (AC8). The Runner's own fetch/commit/push is a
 * runner-package concern (its host-side git CLI, unit-tested there) — what
 * this file proves is that the control plane mints the credentials the
 * Runner needs, hands them over only on the claim path, and never pushes
 * itself.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateId } from "@factory/shared";
import { startTestRig, type TestRig } from "./setup.js";
import { joinRunner, seedReadyStepRun } from "./runner-test-helpers.js";

let repoCounter = 100;

async function createProject(rig: TestRig, ownerCookie: string, name: string): Promise<{ id: string }> {
  const response = await rig.fetchWithCsrf(`${rig.baseUrl}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: ownerCookie },
    body: JSON.stringify({ name }),
  });
  const project = (await response.json()) as { id: string };
  await rig.fetchWithCsrf(`${rig.baseUrl}/projects/${project.id}/members/self`, {
    method: "POST",
    headers: { cookie: ownerCookie },
  });
  return project;
}

async function createRepository(
  rig: TestRig,
  projectId: string,
  name: string,
): Promise<{ id: string; owner: string; name: string }> {
  repoCounter += 1;
  const owner = `gitbus-${repoCounter}`;
  const installationRowId = generateId("installation");
  await rig.pool.query(
    "insert into github_app_installations (id, project_id, installation_id, account_login) values ($1, $2, $3, $4)",
    [installationRowId, projectId, 2_000_000 + repoCounter, owner],
  );
  const repositoryId = generateId("repository");
  await rig.pool.query(
    "insert into repositories (id, project_id, github_app_installation_id, owner, name, default_branch) values ($1, $2, $3, $4, $5, 'main')",
    [repositoryId, projectId, installationRowId, owner, name],
  );
  return { id: repositoryId, owner, name };
}

async function triggerRun(
  rig: TestRig,
  ownerCookie: string,
  projectId: string,
  repositoryId: string,
  yaml: string,
): Promise<Response> {
  const sha = `sha-gitbus-${repoCounter}`;
  rig.gitHost.registerRef({ owner: `gitbus-${repoCounter}`, name: "backend" }, "main", sha);
  rig.gitHost.registerFile({ owner: `gitbus-${repoCounter}`, name: "backend" }, sha, ".factory/pipeline.yaml", yaml);
  return rig.fetchWithCsrf(`${rig.baseUrl}/projects/${projectId}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: ownerCookie },
    body: JSON.stringify({
      id: generateId("run"),
      repositoryId,
      pipelinePath: ".factory/pipeline.yaml",
      refBranch: "main",
    }),
  });
}

describe("Runner protocol: git-as-bus tokens and the /result invariant", () => {
  let rig: TestRig;
  let ownerCookie: string;

  beforeAll(async () => {
    rig = await startTestRig();
    ownerCookie = await rig.loginAsBreakGlass();
  });

  afterAll(async () => {
    await rig.stop();
  });

  it("AC4 — /claim mints exactly two narrow tokens per turn (one fetch, one push), carried in the payload", async () => {
    const { secret, client } = await joinRunner(rig, ownerCookie);
    const { stepRunId } = await seedReadyStepRun(rig.pool);

    const claimed = await client.claim(secret);
    expect(claimed.status).toBe(200);
    const stepRun = (claimed.body as { step_run: { id: string; git_tokens: { fetch: unknown; push: unknown } } | null })
      .step_run;
    expect(stepRun?.id).toBe(stepRunId);

    // Exactly two mints for the one claim — "di-mint dua kali per giliran".
    expect(rig.gitHost.minted).toHaveLength(2);
    // Both scoped to the same repository/installation as the claimed StepRun.
    expect(rig.gitHost.minted[0]!.installationId).toBe(rig.gitHost.minted[1]!.installationId);
    expect(rig.gitHost.minted[0]!.repo.owner).toBe("fixture-owner");

    // The payload carries both, narrow and contents:write-only, 1h lifetime.
    const fetchToken = stepRun!.git_tokens.fetch as { token: string; expires_at: string; repository_ids: number[]; permissions: Record<string, string> };
    const pushToken = stepRun!.git_tokens.push as { token: string; expires_at: string; repository_ids: number[]; permissions: Record<string, string> };
    expect(fetchToken.token).toBeTruthy();
    expect(pushToken.token).toBeTruthy();
    expect(fetchToken.token).not.toBe(pushToken.token);
    expect(fetchToken.permissions).toEqual({ contents: "write" });
    expect(pushToken.permissions).toEqual({ contents: "write" });
    expect(fetchToken.repository_ids).toHaveLength(1);
    expect(pushToken.repository_ids).toHaveLength(1);
    // 1h after the rig's fixed clock (2026-01-01T00:00:00Z).
    expect(fetchToken.expires_at).toBe("2026-01-01T01:00:00.000Z");
  });

  it("AC4 — a claim whose token minting fails un-leases the StepRun instead of leaving it stuck", async () => {
    const { secret, client } = await joinRunner(rig, ownerCookie);
    const { stepRunId } = await seedReadyStepRun(rig.pool, { requiredTags: ["mint-failure-tag"] });

    rig.gitHost.failNextMints = 100; // GitHub down for the whole hold window.
    const claimed = await client.claim(secret, { tags: ["mint-failure-tag"] });
    // The hold elapses with nothing claimable — a 200 with null, not a 5xx.
    expect(claimed.status).toBe(200);
    expect((claimed.body as { step_run: unknown }).step_run).toBeNull();

    const { rows } = await rig.pool.query("select outcome, leased_by, lease_token from step_runs where id = $1", [
      stepRunId,
    ]);
    expect(rows[0]).toEqual({ outcome: "ready", leased_by: null, lease_token: null });

    rig.gitHost.failNextMints = 0; // restore minting for the tests after this one.
  });

  it("AC2 — a succeeded /result without a ref is rejected (StepRun `succeeded` ⇒ ref ada)", async () => {
    const { secret, client } = await joinRunner(rig, ownerCookie);
    const { stepRunId } = await seedReadyStepRun(rig.pool);

    const claimed = await client.claim(secret);
    const stepRun = (claimed.body as { step_run: { id: string; lease_token: string } }).step_run;

    const missingRef = await client.result(secret, stepRun.id, { lease_token: stepRun.lease_token, outcome: "succeeded" });
    expect(missingRef.status).toBe(400);
    expect((missingRef.body as unknown as { code: string }).code).toBe("result_ref_required");

    // The row did not move — still running, still leased, so a correct follow-up still lands.
    const correct = await client.result(secret, stepRun.id, {
      lease_token: stepRun.lease_token,
      outcome: "succeeded",
      ref: { branch: `run/run_0001/implement/t1-a1`, sha: "cafebabe" },
    });
    expect(correct.status).toBe(200);
    const { rows } = await rig.pool.query(
      "select outcome, output_ref_branch, output_ref_sha from step_runs where id = $1",
      [stepRunId],
    );
    expect(rows[0]).toEqual({
      outcome: "succeeded",
      output_ref_branch: "run/run_0001/implement/t1-a1",
      output_ref_sha: "cafebabe",
    });
  });

  it("AC3 — a failed /result uses the same endpoint, records outcome + reason, and carries an optional ref", async () => {
    const { secret, client } = await joinRunner(rig, ownerCookie);
    const { stepRunId } = await seedReadyStepRun(rig.pool);

    const claimed = await client.claim(secret);
    const stepRun = (claimed.body as { step_run: { id: string; lease_token: string } }).step_run;

    const failed = await client.result(secret, stepRun.id, {
      lease_token: stepRun.lease_token,
      outcome: "failed",
      reason: "the shell command exited 1",
      ref: { branch: "run/run_0001/implement/t1-a1", sha: "deadbeef" },
    });
    expect(failed.status).toBe(200);
    expect(failed.body).toMatchObject({ outcome: "failed", ref: { branch: "run/run_0001/implement/t1-a1", sha: "deadbeef" } });

    const { rows } = await rig.pool.query(
      "select outcome, reason, output_ref_branch from step_runs where id = $1",
      [stepRunId],
    );
    expect(rows[0]).toEqual({
      outcome: "failed",
      reason: "the shell command exited 1",
      output_ref_branch: "run/run_0001/implement/t1-a1",
    });

    // A failed result may omit the ref entirely — the branch was never pushed.
    const { secret: s2, client: c2 } = await joinRunner(rig, ownerCookie);
    const { stepRunId: stepRunId2 } = await seedReadyStepRun(rig.pool);
    const claimed2 = await c2.claim(s2);
    const stepRun2 = (claimed2.body as { step_run: { id: string; lease_token: string } }).step_run;
    const noRef = await c2.result(s2, stepRun2.id, {
      lease_token: stepRun2.lease_token,
      outcome: "failed",
      reason: "timed out",
    });
    expect(noRef.status).toBe(200);
    expect(noRef.body).toMatchObject({ outcome: "failed", ref: null });
  });

  it("the Runner-protocol path never pushes on the control plane's behalf — the Runner is the pusher", async () => {
    const { secret, client } = await joinRunner(rig, ownerCookie);
    const { stepRunId } = await seedReadyStepRun(rig.pool);

    const claimed = await client.claim(secret);
    const stepRun = (claimed.body as { step_run: { id: string; lease_token: string } }).step_run;
    await client.result(secret, stepRun.id, {
      lease_token: stepRun.lease_token,
      outcome: "succeeded",
      ref: { branch: "run/x/step/t1-a1", sha: "cafebabe" },
    });

    // GitHost.push is the seam-3 (PR opening) surface; the Runner pushes its
    // own branches with the token it was given. The control plane must stay
    // out of the push path entirely.
    expect(rig.gitHost.pushed).toHaveLength(0);
  });

  it("AC8 — a Pipeline with runsOn: [exec:host] is rejected unless the Project has granted host execution", async () => {
    const project = await createProject(rig, ownerCookie, "host-exec-gate");
    const repo = await createRepository(rig, project.id, "backend");
    const yaml = `version: 1
name: host step
repo: backend
steps:
  build:
    runsOn: [exec:host]
    run: xcodebuild
`;

    const rejected = await triggerRun(rig, ownerCookie, project.id, repo.id, yaml);
    expect(rejected.status).toBe(400);
    expect(((await rejected.json()) as { code: string }).code).toBe("host_exec_not_allowed");

    await rig.pool.query("update projects set host_exec_allowed = true where id = $1", [project.id]);
    const accepted = await triggerRun(rig, ownerCookie, project.id, repo.id, yaml);
    expect(accepted.status).toBe(201);
  });

  it("AC8 — exec:docker is the default and needs no Project permission", async () => {
    const project = await createProject(rig, ownerCookie, "docker-default");
    const repo = await createRepository(rig, project.id, "backend");
    const yaml = `version: 1
name: docker default
repo: backend
steps:
  build:
    runsOn: [exec:docker]
    run: echo docker
  lint:
    run: echo no runsOn at all
`;
    const response = await triggerRun(rig, ownerCookie, project.id, repo.id, yaml);
    expect(response.status).toBe(201);
  });
});
