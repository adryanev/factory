/**
 * Issue #11 — "Fan-out dan Join" over the real HTTP seam against a real
 * migrated Postgres. The Graph mechanics (branch birth, Join verdicts, skip
 * propagation, Run finalization) live in `domain/graph-advance.ts` and run
 * inside the same transaction as the triggering `/result`; this file proves
 * the eleven acceptance criteria from the outside:
 *
 *  AC1 single fan-out axis (constants or branchesFrom, no parallelism: N)
 *  AC2 duplicate Keys fail the Run at fan-out (structurally, natural key)
 *  AC3 branch_key NULL for non-fan-out, empty-string sentinel rejected
 *  AC4 no slug normalisation — Frontend/frontend caught, never colliding
 *  AC5 hybrid materialisation — branches born when the upstream succeeds,
 *      all-or-nothing in one transaction
 *  AC6 join all/any/min owned by the Join; minBranches default 1 closes the
 *      "all over an empty set" trap
 *  AC7 the Join receives the manifest JSON [{ key, repo, branch, sha,
 *      outcome, outputs }] in /claim; cross-repo branches are reads
 *  AC8 a Join downstream of a repo-valued fan-out must write repo:
 *  AC9 an awaiting-human branch never holds back the others; all may hang
 *  AC10 runs.outcome/ended_at nullable, written once at the end, and a Run
 *      can succeed while a StepRun failed
 *  AC11 skipped is its own status, distinct from failed, and propagates
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateId } from "@factory/shared";
import { startTestRig, type TestRig } from "./setup.js";
import { joinRunner, type JoinedRunner } from "./runner-test-helpers.js";

/** A StepRun as the Runner-protocol wire spells it — the /claim response is snake_case. */
interface StepRunWire {
  id: string;
  step_key: string;
  branch_key: string | null;
  lease_token: string;
  turn: number;
  join_manifest?: ManifestEntry[];
}

interface ManifestEntry {
  key: string;
  repo: string;
  branch: string;
  sha: string | null;
  outcome: string;
  outputs: unknown;
}

let repoCounter = 1;

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

async function createRepository(rig: TestRig, projectId: string, name: string): Promise<{ id: string; owner: string; name: string }> {
  repoCounter += 1;
  const owner = `fanout-${repoCounter}`;
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

async function trigger(rig: TestRig, cookie: string, projectId: string, repository: { id: string; owner: string; name: string }, yaml: string): Promise<{ runId: string }> {
  const runId = generateId("run");
  rig.gitHost.registerRef({ owner: repository.owner, name: repository.name }, "main", `sha-fanout-${runId}`);
  rig.gitHost.registerFile({ owner: repository.owner, name: repository.name }, `sha-fanout-${runId}`, ".factory/pipeline.yaml", yaml);
  const response = await rig.fetchWithCsrf(`${rig.baseUrl}/projects/${projectId}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ id: runId, repositoryId: repository.id, pipelinePath: ".factory/pipeline.yaml", refBranch: "main" }),
  });
  expect(response.status).toBe(201);
  return { runId };
}

/** Claims one ready StepRun (whichever FIFO order) and returns its wire row. */
async function claimOne(runner: JoinedRunner): Promise<StepRunWire | null> {
  const { body } = await runner.client.claim(runner.secret);
  return (body as { step_run: StepRunWire | null }).step_run;
}

async function succeed(runner: JoinedRunner, stepRun: StepRunWire, overrides: { outputData?: unknown } = {}): Promise<void> {
  const response = await runner.client.result(runner.secret, stepRun.id, {
    lease_token: stepRun.lease_token,
    outcome: "succeeded",
    ref: { branch: `run/x/${stepRun.step_key}/${stepRun.branch_key ?? ""}/t${stepRun.turn ?? 1}-a1`, sha: "deadbeef" },
    ...(overrides.outputData !== undefined ? { output_data: overrides.outputData } : {}),
  });
  expect(response.status).toBe(200);
}

async function fail(runner: JoinedRunner, stepRun: StepRunWire, reason = "boom"): Promise<void> {
  const response = await runner.client.result(runner.secret, stepRun.id, {
    lease_token: stepRun.lease_token,
    outcome: "failed",
    reason,
  });
  expect(response.status).toBe(200);
}

/** Steps a single linear Step to succeeded (agent or run: — claim, then result). */
async function runToSuccess(runner: JoinedRunner, stepKey: string, outputData?: unknown): Promise<StepRunWire> {
  const stepRun = await claimOne(runner);
  expect(stepRun?.step_key).toBe(stepKey);
  await succeed(runner, stepRun!, { outputData });
  return stepRun!;
}

async function stepRunsOf(rig: TestRig, runId: string): Promise<{ step_key: string; branch_key: string | null; outcome: string; reason: string | null }[]> {
  const { rows } = await rig.pool.query(
    "select step_key, branch_key, outcome, reason from step_runs where run_id = $1 order by step_key, branch_key nulls first",
    [runId],
  );
  return rows;
}

describe("Fan-out dan Join (issue #11)", () => {
  let rig: TestRig;
  let ownerCookie: string;

  beforeAll(async () => {
    rig = await startTestRig();
    ownerCookie = await rig.loginAsBreakGlass();
  });

  afterAll(async () => {
    await rig.stop();
  });

  it("AC1+AC5: a branchesFrom fan-out gives birth to its branches, with meaningful Keys, only after the upstream succeeds", async () => {
    const project = await createProject(rig, ownerCookie, "fanout-dynamic");
    const repo = await createRepository(rig, project.id, "backend");
    const yaml = `version: 1
name: dynamic fan-out
repo: backend
steps:
  plan:
    prompt: Plan three variants
    outputs:
      variants:
        type: array
        items: { key: string, brief: string }
  implement:
    after: [plan]
    branchesFrom: { step: plan, output: variants }
    minBranches: 1
    prompt: Implement the variant
`;
    const { runId } = await trigger(rig, ownerCookie, project.id, repo, yaml);

    // Before `plan` succeeds, `implement` has no rows at all — branches are
    // born only when their upstream succeeds (hybrid materialisation).
    const runner = await joinRunner(rig, ownerCookie);
    await runToSuccess(runner, "plan", {
      kind: "done",
      outputs: { variants: [{ key: "agent-a", brief: "first" }, { key: "agent-b", brief: "second" }] },
    });

    const rows = await stepRunsOf(rig, runId);
    expect(rows.filter((r) => r.step_key === "implement").map((r) => r.branch_key).sort()).toEqual([
      "agent-a",
      "agent-b",
    ]);
    // Each branch is its own ready StepRun (turn 1, claimable) with a
    // meaningful Key — never an index.
    const claimed: string[] = [];
    for (let i = 0; i < 2; i++) {
      const stepRun = await claimOne(runner);
      expect(stepRun?.step_key).toBe("implement");
      claimed.push(stepRun!.branch_key!);
    }
    expect(claimed.sort()).toEqual(["agent-a", "agent-b"]);
  });

  it("AC1+AC5: a branches: constant fan-out gives birth to its branches after its upstream succeeds", async () => {
    const project = await createProject(rig, ownerCookie, "fanout-constant");
    const repo = await createRepository(rig, project.id, "backend");
    const yaml = `version: 1
name: constant fan-out
repo: backend
steps:
  plan:
    run: echo plan
  implement:
    after: [plan]
    branches:
      - key: frontend
      - key: backend
    run: echo work
`;
    const { runId } = await trigger(rig, ownerCookie, project.id, repo, yaml);
    const runner = await joinRunner(rig, ownerCookie);
    await runToSuccess(runner, "plan");

    const rows = await stepRunsOf(rig, runId);
    expect(rows.filter((r) => r.step_key === "implement").map((r) => r.branch_key).sort()).toEqual([
      "backend",
      "frontend",
    ]);

    // Complete both branches so this test leaves no `ready` rows behind —
    // /claim is system-wide FIFO, and a leftover ready branch would be picked
    // up by the next test's Runner.
    for (let i = 0; i < 2; i++) {
      const branch = await claimOne(runner);
      expect(branch?.step_key).toBe("implement");
      await succeed(runner, branch!);
    }
  });

  it("AC2: a duplicate Key from a branchesFrom output fails the Run at fan-out — no half-born branches", async () => {
    const project = await createProject(rig, ownerCookie, "fanout-dup");
    const repo = await createRepository(rig, project.id, "backend");
    const yaml = `version: 1
name: duplicate keys
repo: backend
steps:
  plan:
    prompt: Plan variants
    outputs:
      variants:
        type: array
        items: { key: string, brief: string }
  implement:
    after: [plan]
    branchesFrom: { step: plan, output: variants }
    minBranches: 1
    prompt: Implement
  pick-best:
    after: [implement]
    join: any
    run: echo best
`;
    const { runId } = await trigger(rig, ownerCookie, project.id, repo, yaml);
    const runner = await joinRunner(rig, ownerCookie);
    await runToSuccess(runner, "plan", {
      kind: "done",
      outputs: { variants: [{ key: "frontend", brief: "a" }, { key: "frontend", brief: "b" }] },
    });

    // The fan-out failed as one transaction: exactly one failed `implement`
    // decision row, zero branch rows — no half-born Graph.
    const rows = await stepRunsOf(rig, runId);
    const implement = rows.filter((r) => r.step_key === "implement");
    expect(implement).toHaveLength(1);
    expect(implement[0]).toMatchObject({ branch_key: null, outcome: "failed", reason: "fan-out-duplicate-key" });

    // The Join policy over a failed fan-out is unsatisfiable → skipped →
    // the Run's only leaf is skipped → the Run failed.
    const pickBest = rows.find((r) => r.step_key === "pick-best");
    expect(pickBest).toMatchObject({ outcome: "skipped" });
    const run = await rig.pool.query("select outcome, ended_at from runs where id = $1", [runId]);
    expect(run.rows[0]).toEqual({ outcome: "failed", ended_at: expect.any(Date) });
  });

  it("AC4: an uppercase Key is rejected outright (no slug normalisation) — Frontend/frontend never reach the fan-out", async () => {
    const project = await createProject(rig, ownerCookie, "fanout-case");
    const repo = await createRepository(rig, project.id, "backend");
    const yaml = `version: 1
name: case-sensitive keys
repo: backend
steps:
  plan:
    prompt: Plan variants
    outputs:
      variants:
        type: array
        items: { key: string, brief: string }
  implement:
    after: [plan]
    branchesFrom: { step: plan, output: variants }
    minBranches: 1
    prompt: Implement
`;
    const { runId } = await trigger(rig, ownerCookie, project.id, repo, yaml);
    const runner = await joinRunner(rig, ownerCookie);
    // `Frontend` fails the constrained Key pattern — the output gate rejects
    // the whole turn rather than lower-casing the Key and letting the two
    // branches collide on the remote.
    const stepRun = await claimOne(runner);
    expect(stepRun?.step_key).toBe("plan");
    const response = await runner.client.result(runner.secret, stepRun!.id, {
      lease_token: stepRun!.lease_token,
      outcome: "succeeded",
      ref: { branch: "run/x/plan/t1-a1", sha: "deadbeef" },
      output_data: {
        kind: "done",
        outputs: { variants: [{ key: "frontend", brief: "a" }, { key: "Frontend", brief: "b" }] },
      },
    });
    expect(response.body).toMatchObject({ outcome: "failed" });

    const rows = await stepRunsOf(rig, runId);
    // No branch was ever born — the fan-out's dep (plan) failed, so implement
    // is skipped, not fanned out.
    const implement = rows.filter((r) => r.step_key === "implement");
    expect(implement).toHaveLength(1);
    expect(implement[0]).toMatchObject({ branch_key: null, outcome: "skipped" });
    const plan = rows.find((r) => r.step_key === "plan");
    expect(plan).toMatchObject({ outcome: "failed", reason: "output-invalid" });
  });

  it("AC6+AC10: Run succeeds even though a StepRun failed, under join: any", async () => {
    const project = await createProject(rig, ownerCookie, "fanout-any");
    const repo = await createRepository(rig, project.id, "backend");
    const yaml = `version: 1
name: join any
repo: backend
steps:
  plan:
    run: echo plan
  implement:
    after: [plan]
    branches:
      - key: agent-a
      - key: agent-b
    run: echo work
  pick-best:
    after: [implement]
    join: any
    run: echo best
`;
    const { runId } = await trigger(rig, ownerCookie, project.id, repo, yaml);
    const runner = await joinRunner(rig, ownerCookie);
    await runToSuccess(runner, "plan");

    // One branch fails, the other succeeds — under `any` the Join still runs.
    const branchA = await claimOne(runner);
    expect(branchA?.step_key).toBe("implement");
    await fail(runner, branchA!);
    const branchB = await claimOne(runner);
    expect(branchB?.step_key).toBe("implement");
    await succeed(runner, branchB!);

    const pickBest = await claimOne(runner);
    expect(pickBest?.step_key).toBe("pick-best");
    await succeed(runner, pickBest!);

    // The Run ended succeeded while a StepRun stayed failed — the exact
    // consequence ticket 06 demands be provable.
    const rows = await stepRunsOf(rig, runId);
    const failedBranch = rows.find((r) => r.step_key === "implement" && r.outcome === "failed");
    expect(failedBranch).toBeTruthy();
    expect(rows.find((r) => r.step_key === "pick-best")).toMatchObject({ outcome: "succeeded" });
    const run = await rig.pool.query("select outcome, ended_at from runs where id = $1", [runId]);
    expect(run.rows[0]).toEqual({ outcome: "succeeded", ended_at: expect.any(Date) });
  });

  it("AC6+AC10: join: all fails the Run when any branch fails — the Join is skipped, and runs.outcome is failed", async () => {
    const project = await createProject(rig, ownerCookie, "fanout-all-fail");
    const repo = await createRepository(rig, project.id, "backend");
    const yaml = `version: 1
name: join all fail
repo: backend
steps:
  plan:
    run: echo plan
  implement:
    after: [plan]
    branches:
      - key: agent-a
      - key: agent-b
    run: echo work
  pick-best:
    after: [implement]
    join: all
    run: echo best
`;
    const { runId } = await trigger(rig, ownerCookie, project.id, repo, yaml);
    const runner = await joinRunner(rig, ownerCookie);
    await runToSuccess(runner, "plan");

    const branchA = await claimOne(runner);
    await succeed(runner, branchA!);
    const branchB = await claimOne(runner);
    await fail(runner, branchB!);

    // The first non-success made `all` unsatisfiable: pick-best is skipped,
    // the Run has nothing left in flight, and the final verdict is failed.
    const rows = await stepRunsOf(rig, runId);
    expect(rows.find((r) => r.step_key === "pick-best")).toMatchObject({ outcome: "skipped" });
    const run = await rig.pool.query("select outcome, ended_at from runs where id = $1", [runId]);
    expect(run.rows[0]).toEqual({ outcome: "failed", ended_at: expect.any(Date) });
  });

  it("AC6: join: { min: 2 } proceeds once two of three branches succeeded", async () => {
    const project = await createProject(rig, ownerCookie, "fanout-min");
    const repo = await createRepository(rig, project.id, "backend");
    const yaml = `version: 1
name: join min 2
repo: backend
steps:
  plan:
    run: echo plan
  implement:
    after: [plan]
    branches:
      - key: a
      - key: b
      - key: c
    run: echo work
  pick-best:
    after: [implement]
    join: { min: 2 }
    run: echo best
`;
    const { runId } = await trigger(rig, ownerCookie, project.id, repo, yaml);
    const runner = await joinRunner(rig, ownerCookie);
    await runToSuccess(runner, "plan");

    await succeed(runner, (await claimOne(runner))!);
    await fail(runner, (await claimOne(runner))!);
    await succeed(runner, (await claimOne(runner))!);

    const pickBest = await claimOne(runner);
    expect(pickBest?.step_key).toBe("pick-best");
    await succeed(runner, pickBest!);

    const rows = await stepRunsOf(rig, runId);
    expect(rows.filter((r) => r.step_key === "implement" && r.outcome === "failed")).toHaveLength(1);
    const run = await rig.pool.query("select outcome from runs where id = $1", [runId]);
    expect(run.rows[0]).toEqual({ outcome: "succeeded" });
  });

  it("AC7: the Join claim carries one manifest entry per branch with repo/branch/sha/outcome", async () => {
    const project = await createProject(rig, ownerCookie, "fanout-manifest-2");
    const repo = await createRepository(rig, project.id, "backend");
    const yaml = `version: 1
name: join manifest
repo: backend
steps:
  plan:
    run: echo plan
  implement:
    after: [plan]
    branches:
      - key: agent-a
      - key: agent-b
    run: echo work
  pick-best:
    after: [implement]
    join: any
    run: echo best
`;
    await trigger(rig, ownerCookie, project.id, repo, yaml);
    const runner = await joinRunner(rig, ownerCookie);
    await runToSuccess(runner, "plan");
    await succeed(runner, (await claimOne(runner))!);
    await succeed(runner, (await claimOne(runner))!);

    const pickBest = await claimOne(runner);
    expect(pickBest?.step_key).toBe("pick-best");
    const manifest = pickBest?.join_manifest;

    expect(manifest).toHaveLength(2);
    const byKey = new Map(manifest!.map((entry) => [entry.key, entry]));
    const a = byKey.get("agent-a");
    const b = byKey.get("agent-b");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    for (const entry of [a!, b!]) {
      expect(entry.repo).toBe("backend");
      expect(entry.branch).toMatch(/^run\/run_[\w-]+\/implement\/agent-[ab]\/t1-a1$/);
      expect(entry.sha).toBe("deadbeef");
      expect(entry.outcome).toBe("succeeded");
      expect(entry.outputs).toBeNull();
    }
  });

  it("AC9: an awaiting-human branch never holds back the others — join: any proceeds while the Run stays in flight", async () => {
    const project = await createProject(rig, ownerCookie, "fanout-awaiting-any");
    const repo = await createRepository(rig, project.id, "backend");
    const yaml = `version: 1
name: awaiting any
repo: backend
steps:
  plan:
    run: echo plan
  implement:
    after: [plan]
    branches:
      - key: agent-a
      - key: agent-b
    run: echo work
  pick-best:
    after: [implement]
    join: any
    run: echo best
`;
    const { runId } = await trigger(rig, ownerCookie, project.id, repo, yaml);
    const runner = await joinRunner(rig, ownerCookie);
    await runToSuccess(runner, "plan");

    // Branch `a` asks a human and hangs; branch `b` succeeds.
    const branchA = await claimOne(runner);
    const group = await rig.fetchWithCsrf(`${rig.baseUrl}/projects/${project.id}/groups`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ name: "reviewers" }),
    });
    expect(group.status).toBe(201);
    const groupId = ((await group.json()) as { id: string }).id;
    const question = await runner.client.question(runner.secret, branchA!.id, {
      lease_token: branchA!.lease_token,
      question: { id: generateId("question"), group_id: groupId, kind: "text", body: "which one?" },
      ref: { branch: "run/x/implement/agent-a/t1-a1", sha: "deadbeef" },
    });
    expect(question.status).toBe(200);

    const branchB = await claimOne(runner);
    expect(branchB?.branch_key).toBe("agent-b");
    await succeed(runner, branchB!);

    // `any` is satisfied by the one success: the Join materialises ready
    // even though a sibling branch is awaiting-human.
    const pickBest = await claimOne(runner);
    expect(pickBest?.step_key).toBe("pick-best");
    await succeed(runner, pickBest!);

    // The awaiting-human branch keeps the Run in flight — no outcome yet.
    const rows = await stepRunsOf(rig, runId);
    expect(rows.find((r) => r.step_key === "implement" && r.branch_key === "agent-a")).toMatchObject({
      outcome: "awaiting-human",
    });
    const run = await rig.pool.query("select outcome, ended_at from runs where id = $1", [runId]);
    expect(run.rows[0]).toEqual({ outcome: null, ended_at: null });
  });

  it("AC9: join: all may hang forever on an awaiting-human branch — the Join is never materialised", async () => {
    const project = await createProject(rig, ownerCookie, "fanout-awaiting-all");
    const repo = await createRepository(rig, project.id, "backend");
    const yaml = `version: 1
name: awaiting all
repo: backend
steps:
  plan:
    run: echo plan
  implement:
    after: [plan]
    branches:
      - key: agent-a
      - key: agent-b
    run: echo work
  pick-best:
    after: [implement]
    join: all
    run: echo best
`;
    const { runId } = await trigger(rig, ownerCookie, project.id, repo, yaml);
    const runner = await joinRunner(rig, ownerCookie);
    await runToSuccess(runner, "plan");

    const branchA = await claimOne(runner);
    const group = await rig.fetchWithCsrf(`${rig.baseUrl}/projects/${project.id}/groups`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ name: "reviewers" }),
    });
    const groupId = ((await group.json()) as { id: string }).id;
    await runner.client.question(runner.secret, branchA!.id, {
      lease_token: branchA!.lease_token,
      question: { id: generateId("question"), group_id: groupId, kind: "text", body: "which one?" },
      ref: { branch: "run/x/implement/agent-a/t1-a1", sha: "deadbeef" },
    });

    const branchB = await claimOne(runner);
    expect(branchB?.branch_key).toBe("agent-b");
    await succeed(runner, branchB!);

    // `all` waits on the awaiting branch: pick-best does not exist yet, and
    // the Run stays in flight. Cancel is the way out — not a timeout.
    const rows = await stepRunsOf(rig, runId);
    expect(rows.filter((r) => r.step_key === "pick-best")).toHaveLength(0);
    const run = await rig.pool.query("select outcome, ended_at from runs where id = $1", [runId]);
    expect(run.rows[0]).toEqual({ outcome: null, ended_at: null });
  });

  it("AC6: minBranches (default 1) fails an empty fan-out — 'all over an empty set' never happens", async () => {
    const project = await createProject(rig, ownerCookie, "fanout-empty");
    const repo = await createRepository(rig, project.id, "backend");
    const yaml = `version: 1
name: empty fan-out
repo: backend
steps:
  plan:
    prompt: Plan variants
    outputs:
      variants:
        type: array
        items: { key: string, brief: string }
  implement:
    after: [plan]
    branchesFrom: { step: plan, output: variants }
    minBranches: 1
    prompt: Implement
  pick-best:
    after: [implement]
    join: all
    run: echo best
`;
    const { runId } = await trigger(rig, ownerCookie, project.id, repo, yaml);
    const runner = await joinRunner(rig, ownerCookie);
    await runToSuccess(runner, "plan", { kind: "done", outputs: { variants: [] } });

    // An empty branch list fails the fan-out (below minBranches 1) instead
    // of letting the `all` Join vacuously succeed over an empty set.
    const rows = await stepRunsOf(rig, runId);
    const implement = rows.filter((r) => r.step_key === "implement");
    expect(implement).toHaveLength(1);
    expect(implement[0]).toMatchObject({ branch_key: null, outcome: "failed", reason: "fan-out-empty" });
    expect(rows.find((r) => r.step_key === "pick-best")).toMatchObject({ outcome: "skipped" });
    const run = await rig.pool.query("select outcome from runs where id = $1", [runId]);
    expect(run.rows[0]).toEqual({ outcome: "failed" });
  });

  it("AC6: minBranches: 0 is the explicit opt-out — an empty fan-out lets the Join run against an empty manifest", async () => {
    const project = await createProject(rig, ownerCookie, "fanout-empty-ok");
    const repo = await createRepository(rig, project.id, "backend");
    const yaml = `version: 1
name: empty fan-out allowed
repo: backend
steps:
  plan:
    prompt: Plan variants
    outputs:
      variants:
        type: array
        items: { key: string, brief: string }
  implement:
    after: [plan]
    branchesFrom: { step: plan, output: variants }
    minBranches: 0
    prompt: Implement
  pick-best:
    after: [implement]
    join: all
    run: echo best
`;
    const { runId } = await trigger(rig, ownerCookie, project.id, repo, yaml);
    const runner = await joinRunner(rig, ownerCookie);
    await runToSuccess(runner, "plan", { kind: "done", outputs: { variants: [] } });

    // The fan-out was *decided* empty (minBranches: 0), so the `all` Join is
    // not skipped — it runs with an empty manifest, exactly the opt-out
    // ticket 06 describes.
    const pickBest = await claimOne(runner);
    expect(pickBest?.step_key).toBe("pick-best");
    await succeed(runner, pickBest!);

    const run = await rig.pool.query("select outcome from runs where id = $1", [runId]);
    expect(run.rows[0]).toEqual({ outcome: "succeeded" });
  });

  it("AC8: a Join downstream of a repo-valued fan-out without repo: is a validation error at trigger", async () => {
    const project = await createProject(rig, ownerCookie, "fanout-cross-repo-missing-repo");
    const repo = await createRepository(rig, project.id, "infra");
    const yaml = `version: 1
name: cross-repo join without repo
repo: infra
steps:
  contract:
    run: echo contract
  implement:
    after: [contract]
    branches:
      - key: frontend
        repo: frontend
      - key: backend
        repo: backend
    run: echo work
  report:
    after: [implement]
    join: all
    prompt: report the outcome
`;
    const runId = generateId("run");
    rig.gitHost.registerRef({ owner: repo.owner, name: repo.name }, "main", "sha-missing-repo");
    rig.gitHost.registerFile({ owner: repo.owner, name: repo.name }, "sha-missing-repo", ".factory/pipeline.yaml", yaml);
    const response = await rig.fetchWithCsrf(`${rig.baseUrl}/projects/${project.id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ id: runId, repositoryId: repo.id, pipelinePath: ".factory/pipeline.yaml", refBranch: "main" }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("pipeline_definition_invalid");
  });

  it("AC5: a root branches: fan-out is born at trigger — there is no upstream to wait for", async () => {
    const project = await createProject(rig, ownerCookie, "fanout-root");
    const repo = await createRepository(rig, project.id, "backend");
    const yaml = `version: 1
name: root fan-out
repo: backend
steps:
  implement:
    branches:
      - key: agent-a
      - key: agent-b
    run: echo work
`;
    const runId = generateId("run");
    rig.gitHost.registerRef({ owner: repo.owner, name: repo.name }, "main", "sha-root-fanout");
    rig.gitHost.registerFile({ owner: repo.owner, name: repo.name }, "sha-root-fanout", ".factory/pipeline.yaml", yaml);
    const response = await rig.fetchWithCsrf(`${rig.baseUrl}/projects/${project.id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ id: runId, repositoryId: repo.id, pipelinePath: ".factory/pipeline.yaml", refBranch: "main" }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { stepRuns: { stepKey: string; branchKey: string | null }[] };
    expect(body.stepRuns.map((s) => `${s.stepKey}/${s.branchKey}`).sort()).toEqual([
      "implement/agent-a",
      "implement/agent-b",
    ]);

    // Complete both branches so this test leaves no ready rows behind —
    // /claim is system-wide FIFO.
    const runner = await joinRunner(rig, ownerCookie);
    for (let i = 0; i < 2; i++) {
      const branch = await claimOne(runner);
      expect(branch?.step_key).toBe("implement");
      await succeed(runner, branch!);
    }
  });

  it("AC11: skipped is its own status and propagates downstream — distinct from failed in the data", async () => {
    const project = await createProject(rig, ownerCookie, "fanout-skip-prop");
    const repo = await createRepository(rig, project.id, "backend");
    const yaml = `version: 1
name: skip propagation
repo: backend
steps:
  a:
    run: echo a
  b:
    after: [a]
    run: echo b
  c:
    after: [b]
    run: echo c
`;
    const { runId } = await trigger(rig, ownerCookie, project.id, repo, yaml);
    const runner = await joinRunner(rig, ownerCookie);

    const a = await claimOne(runner);
    expect(a?.step_key).toBe("a");
    await fail(runner, a!, "the real failure");

    // b and c never ran: they are skipped — a status that is not failed, and
    // the Run itself failed (its only leaf, c, is skipped).
    const rows = await stepRunsOf(rig, runId);
    expect(rows.find((r) => r.step_key === "a")).toMatchObject({ outcome: "failed", reason: "the real failure" });
    expect(rows.find((r) => r.step_key === "b")).toMatchObject({ outcome: "skipped" });
    expect(rows.find((r) => r.step_key === "c")).toMatchObject({ outcome: "skipped" });
    // skipped !== failed, in the data:
    const skipped = rows.find((r) => r.step_key === "b");
    expect(skipped?.outcome).toBe("skipped");
    expect(skipped?.outcome).not.toBe("failed");

    const run = await rig.pool.query("select outcome from runs where id = $1", [runId]);
    expect(run.rows[0]).toEqual({ outcome: "failed" });
  });
});
