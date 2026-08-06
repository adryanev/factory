/**
 * Issue #25 — `unschedulableAfter` is enforced (it was only ever validated
 * and serialized, never read by the control plane). Over the seam-1 rig:
 * real Postgres, real HTTP, the injected clock driving every deadline —
 * nothing here reads the wall clock.
 *
 * The acceptance criteria, mapped to the tests below:
 *  - the threshold is computed from an explicit recorded point — the row
 *    stores `unschedulable_after = ready_at + unschedulableAfter` the moment
 *    it is materialized, not derived at query time (test 1);
 *  - a StepRun past the threshold stops being claimable, while the same row
 *    was claimable before it (test 2, deterministic via `rig.setClock`);
 *  - the state becomes visible and explainable, not just "gone from the
 *    queue": the sweep moves the stale row to the `unschedulable` outcome
 *    (with a recorded reason), its dependents become `skipped`, the Run ends
 *    `failed`, and the runs API serves the state (test 3);
 *  - a Pipeline without `unschedulableAfter` is untouched — no deadline,
 *    still claimable forever (test 4).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateId } from "@factory/shared";
import { sweepExpiredLeases } from "../../src/domain/step-run-ops.js";
import { startTestRig, type TestRig } from "./setup.js";
import { joinRunner } from "./runner-test-helpers.js";

const PIPELINE_PATH = ".factory/pipeline.yaml";

let repoCounter = 1000;

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
  const owner = `unsched-${repoCounter}`;
  const installationRowId = generateId("installation");
  await rig.pool.query(
    "insert into github_app_installations (id, project_id, installation_id, account_login) values ($1, $2, $3, $4)",
    [installationRowId, projectId, 30_000_000 + repoCounter, owner],
  );
  const repositoryId = generateId("repository");
  await rig.pool.query(
    "insert into repositories (id, project_id, github_app_installation_id, owner, name, default_branch) values ($1, $2, $3, $4, $5, 'main')",
    [repositoryId, projectId, installationRowId, owner, name],
  );
  return { id: repositoryId, owner, name };
}

interface TriggerResponse {
  run: { id: string; refSha: string };
  stepRuns: { id: string; stepKey: string; outcome: string }[];
}

async function trigger(
  rig: TestRig,
  ownerCookie: string,
  projectId: string,
  repositoryId: string,
  yaml: string,
): Promise<TriggerResponse> {
  const repoRef = { owner: (await rig.pool.query<{ owner: string }>(`select owner from repositories where id = $1`, [repositoryId])).rows[0]!.owner, name: (await rig.pool.query<{ name: string }>(`select name from repositories where id = $1`, [repositoryId])).rows[0]!.name };
  rig.gitHost.registerRef(repoRef, "main", "sha-unsched-1");
  rig.gitHost.registerFile(repoRef, "sha-unsched-1", PIPELINE_PATH, yaml);

  const runId = generateId("run");
  const response = await rig.fetchWithCsrf(`${rig.baseUrl}/projects/${projectId}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: ownerCookie },
    body: JSON.stringify({ id: runId, repositoryId, pipelinePath: PIPELINE_PATH, refBranch: "main" }),
  });
  if (response.status !== 201) {
    throw new Error(`trigger failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as TriggerResponse;
}

const WITH_DEADLINE = `version: 1
name: unschedulable pipeline
repo: backend
unschedulableAfter: 2h
steps:
  plan:
    run: "echo plan"
  review:
    after: [plan]
    run: "echo review"
`;

const WITHOUT_DEADLINE = `version: 1
name: plain pipeline
repo: backend
steps:
  plan:
    run: "echo plan"
`;

describe("unschedulableAfter", () => {
  let rig: TestRig;
  let ownerCookie: string;

  beforeAll(async () => {
    rig = await startTestRig();
    ownerCookie = await rig.loginAsBreakGlass();
  });

  afterAll(async () => {
    await rig.stop();
  });

  it("records the deadline at materialization: unschedulable_after = ready_at + unschedulableAfter, from the injected clock", async () => {
    const project = await createProject(rig, ownerCookie, "unsched-record");
    const repo = await createRepository(rig, project.id, "backend");
    const body = await trigger(rig, ownerCookie, project.id, repo.id, WITH_DEADLINE);

    expect(body.stepRuns).toHaveLength(1);
    const { rows } = await rig.pool.query<{ ready_at: Date; unschedulable_after: Date | null }>(
      `select ready_at, unschedulable_after from step_runs where id = $1`,
      [body.stepRuns[0]!.id],
    );
    const row = rows[0]!;
    expect(row.unschedulable_after).not.toBeNull();
    expect(row.unschedulable_after!.getTime() - row.ready_at.getTime()).toBe(2 * 60 * 60 * 1000);
    // The reference point is the rig clock's materialization instant, not the
    // database server's wall clock.
    expect(row.ready_at.getTime()).toBe(new Date("2026-01-01T00:00:00.000Z").getTime());

    // The claim query is global FIFO and this rig's database is shared
    // across the file's tests — take the row out of the queue so the next
    // test's claim is deterministic.
    await rig.pool.query(`update step_runs set outcome = 'succeeded' where id = $1`, [
      body.stepRuns[0]!.id,
    ]);
  });

  it("is claimable before the deadline and stops being claimable once it passes — driven by the injected clock", async () => {
    rig.setClock(new Date("2026-01-01T00:00:00.000Z"));
    const project = await createProject(rig, ownerCookie, "unsched-claim");
    const repo = await createRepository(rig, project.id, "backend");
    const body = await trigger(rig, ownerCookie, project.id, repo.id, WITH_DEADLINE);
    const { secret, client } = await joinRunner(rig, ownerCookie);

    // Before the deadline (clock = materialization instant): claimed at once.
    const before = await client.claim(secret);
    expect(before.status).toBe(200);
    expect((before.body as { step_run: { id: string } | null }).step_run?.id).toBe(body.stepRuns[0]!.id);

    // Put the row back on the queue the way a lost lease would.
    await rig.pool.query(
      `update step_runs set outcome = 'ready', leased_by = null, lease_token = null, lease_expires_at = null where id = $1`,
      [body.stepRuns[0]!.id],
    );

    // Past the deadline (clock moved): the same row is unclaimable — the
    // claim query itself refuses it, no sweep involved.
    rig.setClock(new Date("2026-01-01T02:01:00.000Z"));
    const after = await client.claim(secret);
    expect(after.status).toBe(200);
    expect((after.body).step_run).toBeNull();

    // Take the row out of the queue so the next test's claim is deterministic.
    await rig.pool.query(`update step_runs set outcome = 'succeeded' where id = $1`, [
      body.stepRuns[0]!.id,
    ]);
  });

  it("sweep moves a stale ready StepRun to the explainable unschedulable state, its dependent is skipped, and the Run ends failed — visible over the runs API", async () => {
    rig.setClock(new Date("2026-01-01T00:00:00.000Z"));
    const project = await createProject(rig, ownerCookie, "unsched-sweep");
    const repo = await createRepository(rig, project.id, "backend");
    const body = await trigger(rig, ownerCookie, project.id, repo.id, WITH_DEADLINE);
    const planId = body.stepRuns[0]!.id;

    rig.setClock(new Date("2026-01-01T02:01:00.000Z"));
    await sweepExpiredLeases(rig.deps);

    const { rows } = await rig.pool.query<{ id: string; outcome: string; reason: string | null }>(
      `select id, outcome, reason from step_runs where run_id = $1 order by step_key`,
      [body.run.id],
    );
    const plan = rows.find((row) => row.id === planId)!;
    expect(plan.outcome).toBe("unschedulable");
    expect(plan.reason).toBe("unschedulable-after-elapsed");
    // The dependent never ran — the Graph advanced from the terminal row.
    const review = rows.find((row) => row.id !== planId)!;
    expect(review.outcome).toBe("skipped");

    const run = await rig.pool.query<{ outcome: string | null }>(`select outcome from runs where id = $1`, [
      body.run.id,
    ]);
    expect(run.rows[0]!.outcome).toBe("failed");

    // Criterion 1: the explainable state is what the UI reads.
    const detailResponse = await rig.fetchWithCsrf(
      `${rig.baseUrl}/projects/${project.id}/runs/${body.run.id}`,
      { headers: { cookie: ownerCookie } },
    );
    expect(detailResponse.status).toBe(200);
    const detail = (await detailResponse.json()) as {
      stepRuns: { id: string; outcome: string; reason: string | null }[];
    };
    const servedPlan = detail.stepRuns.find((stepRun) => stepRun.id === planId)!;
    expect(servedPlan.outcome).toBe("unschedulable");
    expect(servedPlan.reason).toBe("unschedulable-after-elapsed");
  });

  it("a Pipeline without unschedulableAfter records no deadline and stays claimable", async () => {
    rig.setClock(new Date("2026-01-01T00:00:00.000Z"));
    const project = await createProject(rig, ownerCookie, "unsched-plain");
    const repo = await createRepository(rig, project.id, "backend");
    const body = await trigger(rig, ownerCookie, project.id, repo.id, WITHOUT_DEADLINE);
    const { secret, client } = await joinRunner(rig, ownerCookie);

    const { rows } = await rig.pool.query<{ unschedulable_after: Date | null }>(
      `select unschedulable_after from step_runs where id = $1`,
      [body.stepRuns[0]!.id],
    );
    expect(rows[0]!.unschedulable_after).toBeNull();

    const claimed = await client.claim(secret);
    expect((claimed.body as { step_run: { id: string } | null }).step_run?.id).toBe(body.stepRuns[0]!.id);
  });
});
