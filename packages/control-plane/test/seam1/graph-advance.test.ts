/**
 * Not one of issue #5's 13 acceptance criteria by itself, but the mechanism
 * `/result` needs to exist for the *system* to move at all: issue #4 only
 * materializes root Steps (`.scratch/.../acceptance-index.md`, Issue 4
 * deviation 3) and left "advance the Graph when a Step finishes" for this
 * issue's `/result` to trigger. This proves the smallest version of that
 * (`domain/graph-advance.ts`, shape (a) — see that file's header): a
 * two-Step linear chain, `a` then `b` after `a`, where `b` is unclaimable
 * until `a`'s `/result` commits `succeeded`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateId } from "@factory/shared";
import { startTestRig, type TestRig } from "./setup.js";
import { joinRunner } from "./runner-test-helpers.js";

async function createProject(rig: TestRig, cookie: string, name: string): Promise<{ id: string }> {
  const response = await rig.fetchWithCsrf(`${rig.baseUrl}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name }),
  });
  const project = (await response.json()) as { id: string };
  await rig.fetchWithCsrf(`${rig.baseUrl}/projects/${project.id}/members/self`, {
    method: "POST",
    headers: { cookie },
  });
  return project;
}

async function createRepository(
  rig: TestRig,
  projectId: string,
  name: string,
): Promise<{ id: string; owner: string; name: string }> {
  const installationRowId = generateId("installation");
  const owner = `graph-advance-${Math.random().toString(36).slice(2)}`;
  await rig.pool.query(
    "insert into github_app_installations (id, project_id, installation_id, account_login) values ($1, $2, $3, $4)",
    [installationRowId, projectId, Math.floor(Math.random() * 1_000_000_000), owner],
  );
  const repositoryId = generateId("repository");
  await rig.pool.query(
    "insert into repositories (id, project_id, github_app_installation_id, owner, name, default_branch) values ($1, $2, $3, $4, $5, 'main')",
    [repositoryId, projectId, installationRowId, owner, name],
  );
  return { id: repositoryId, owner, name };
}

describe("Graph advance: /result schedules dependents whose after: is now satisfied", () => {
  let rig: TestRig;
  let ownerCookie: string;

  beforeAll(async () => {
    rig = await startTestRig();
    ownerCookie = await rig.loginAsBreakGlass();
  });

  afterAll(async () => {
    await rig.stop();
  });

  it("materializes Step b only after Step a's /result commits succeeded, and it is then claimable by a different Runner", async () => {
    const project = await createProject(rig, ownerCookie, "graph-advance-project");
    const repo = await createRepository(rig, project.id, "chain");

    rig.gitHost.registerRef(repo, "main", "sha-graph-advance-1");
    rig.gitHost.registerFile(
      repo,
      "sha-graph-advance-1",
      ".factory/pipeline.yaml",
      "version: 1\nname: two step chain\nrepo: chain\nsteps:\n  a:\n    run: echo a\n  b:\n    after: [a]\n    run: echo b\n",
    );

    const runId = generateId("run");
    const triggerResponse = await rig.fetchWithCsrf(`${rig.baseUrl}/projects/${project.id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ id: runId, repositoryId: repo.id, pipelinePath: ".factory/pipeline.yaml", refBranch: "main" }),
    });
    expect(triggerResponse.status).toBe(201);
    const triggered = (await triggerResponse.json()) as { stepRuns: { stepKey: string }[] };
    // Only `a` materializes at trigger time — `b` is behind an unmet dependency (issue #4's own scope boundary).
    expect(triggered.stepRuns.map((s) => s.stepKey)).toEqual(["a"]);

    const runnerA = await joinRunner(rig, ownerCookie);
    const claimA = await runnerA.client.claim(runnerA.secret);
    const stepRunA = (claimA.body as { step_run: { id: string; lease_token: string; step_key: string } }).step_run;
    expect(stepRunA.step_key).toBe("a");

    // Before `a` finishes, `b` does not exist as a row at all yet.
    const beforeRows = await rig.pool.query("select step_key from step_runs where run_id = $1", [runId]);
    expect(beforeRows.rows.map((r: { step_key: string }) => r.step_key)).toEqual(["a"]);

    const resultResponse = await runnerA.client.result(runnerA.secret, stepRunA.id, {
      lease_token: stepRunA.lease_token,
      outcome: "succeeded",
      ref: { branch: `run/${runId}/a/t1-a1`, sha: "deadbeef" },
    });
    expect(resultResponse.status).toBe(200);

    // `b` now exists, `ready`, materialized by graph-advance.ts.
    const afterRows = await rig.pool.query<{ step_key: string; outcome: string }>(
      "select step_key, outcome from step_runs where run_id = $1 order by step_key",
      [runId],
    );
    expect(afterRows.rows).toEqual([
      { step_key: "a", outcome: "succeeded" },
      { step_key: "b", outcome: "ready" },
    ]);

    // And a different Runner can claim it over real HTTP.
    const runnerB = await joinRunner(rig, ownerCookie);
    const claimB = await runnerB.client.claim(runnerB.secret);
    expect((claimB.body as { step_run: { step_key: string } | null }).step_run?.step_key).toBe("b");
  });

  it("does not schedule a dependent Step until every one of its after: dependencies has succeeded", async () => {
    const project = await createProject(rig, ownerCookie, "graph-advance-join-project");
    const repo = await createRepository(rig, project.id, "chain");

    rig.gitHost.registerRef(repo, "main", "sha-graph-advance-2");
    rig.gitHost.registerFile(
      repo,
      "sha-graph-advance-2",
      ".factory/pipeline.yaml",
      "version: 1\nname: join of two roots\nrepo: chain\nsteps:\n  x:\n    run: echo x\n  y:\n    run: echo y\n  z:\n    after: [x, y]\n    run: echo z\n",
    );

    const runId = generateId("run");
    const triggerResponse = await rig.fetchWithCsrf(`${rig.baseUrl}/projects/${project.id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ id: runId, repositoryId: repo.id, pipelinePath: ".factory/pipeline.yaml", refBranch: "main" }),
    });
    expect(triggerResponse.status).toBe(201);

    const runner = await joinRunner(rig, ownerCookie, { slots: 10, tags: [] });
    const claimX = await runner.client.claim(runner.secret);
    const stepRunX = (claimX.body as { step_run: { id: string; lease_token: string; step_key: string } }).step_run;
    expect(stepRunX.step_key).toBe("x");

    await runner.client.result(runner.secret, stepRunX.id, {
      lease_token: stepRunX.lease_token,
      outcome: "succeeded",
      ref: { branch: `run/${runId}/x/t1-a1`, sha: "deadbeef" },
    });

    // `z` needs both `x` and `y` — only `x` is done, so `z` must not exist yet.
    const rowsAfterX = await rig.pool.query("select step_key from step_runs where run_id = $1", [runId]);
    expect(rowsAfterX.rows.map((r: { step_key: string }) => r.step_key).sort()).toEqual(["x", "y"]);

    const claimY = await runner.client.claim(runner.secret);
    const stepRunY = (claimY.body as { step_run: { id: string; lease_token: string; step_key: string } }).step_run;
    expect(stepRunY.step_key).toBe("y");
    await runner.client.result(runner.secret, stepRunY.id, {
      lease_token: stepRunY.lease_token,
      outcome: "succeeded",
      ref: { branch: `run/${runId}/y/t1-a1`, sha: "deadbeef" },
    });

    const rowsAfterY = await rig.pool.query<{ step_key: string; outcome: string }>(
      "select step_key, outcome from step_runs where run_id = $1 order by step_key",
      [runId],
    );
    expect(rowsAfterY.rows).toEqual([
      { step_key: "x", outcome: "succeeded" },
      { step_key: "y", outcome: "succeeded" },
      { step_key: "z", outcome: "ready" },
    ]);
  });
});
