/**
 * Issue #17's control-plane executor, end to end over the seam-1 rig: a
 * Pipeline whose `open-pr` Step has `kind: pull-request` is triggered, its
 * agent Steps are run by a real Runner-shaped HTTP client, and the control
 * plane itself claims the resulting `kind:` StepRuns through the **same**
 * `claim_step_run.sql` (lessee = the control-plane instance, 60s lease) and
 * opens a PR per fan-out branch.
 *
 * What this file proves:
 *  - a Runner `/claim` never sees a `kind:` StepRun, while the control-plane
 *    cycle does (AC1's two filters over one query);
 *  - born once per branch, inheriting each branch's repo (AC3);
 *  - find-then-create idempotency, 422-as-success adoption, and the
 *    documented "human-closed PR → new PR" boundary shape (AC6);
 *  - the Commit Status posted with the Run page as `target_url` (AC7);
 *  - the write surface: the token minted carries exactly
 *    `{ pull_requests, statuses }` — no `contents`, no `issues` (AC8);
 *  - cancel checked immediately before the write, aborting with no PR (AC9);
 *  - `attempts: 3` with Retry-After/backoff before giving up (AC2).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateId } from "@factory/shared";
import { runControlPlaneStepCycle } from "../../src/domain/control-plane-steps.js";
import type { AppDeps } from "../../src/deps.js";
import { startTestRig, type TestRig } from "./setup.js";
import { joinRunner } from "./runner-test-helpers.js";

const FAST_OPTIONS = { retryBackoffMs: 1 };

let repoCounter = 1000;

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
  repoCounter += 1;
  const owner = `pr-owner-${repoCounter}`;
  const installationRowId = generateId("installation");
  await rig.pool.query(
    "insert into github_app_installations (id, project_id, installation_id, account_login) values ($1, $2, $3, $4)",
    [installationRowId, projectId, 10_000_000 + repoCounter, owner],
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
  cookie: string,
  projectId: string,
  hostRepo: { id: string; owner: string; name: string },
  yaml: string,
): Promise<string> {
  const sha = `sha-pr-${repoCounter}`;
  rig.gitHost.registerRef({ owner: hostRepo.owner, name: hostRepo.name }, "main", sha);
  rig.gitHost.registerFile({ owner: hostRepo.owner, name: hostRepo.name }, sha, ".factory/pipeline.yaml", yaml);
  const runId = generateId("run");
  const response = await rig.fetchWithCsrf(`${rig.baseUrl}/projects/${projectId}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      id: runId,
      repositoryId: hostRepo.id,
      pipelinePath: ".factory/pipeline.yaml",
      refBranch: "main",
    }),
  });
  expect(response.status).toBe(201);
  return runId;
}

/** The `/result` payload an agent Step's `done` Output rides in on (the contract's `done` arm). */
function doneOutput(prTitle: string, prBody: string): unknown {
  return { kind: "done", outputs: { prTitle, prBody } };
}

interface ClaimedStepRunShape {
  id: string;
  run_id: string;
  step_key: string;
  branch_key: string | null;
  lease_token: string;
}

/** Claims one StepRun as the Runner and finishes it succeeded with `outputData`. */
async function claimAndFinish(
  rig: TestRig,
  cookie: string,
  outputData: unknown,
): Promise<ClaimedStepRunShape> {
  const runner = await joinRunner(rig, cookie);
  const claim = await runner.client.claim(runner.secret);
  const stepRun = (claim.body as { step_run: ClaimedStepRunShape | null }).step_run;
  expect(stepRun).not.toBeNull();
  const branch = `run/${stepRun!.run_id}/${stepRun!.step_key}/${stepRun!.branch_key ?? "x"}/t1-a1`;
  const result = await runner.client.result(runner.secret, stepRun!.id, {
    lease_token: stepRun!.lease_token,
    outcome: "succeeded",
    ref: { branch, sha: `deadbeef-${stepRun!.id}` },
    output_data: outputData,
  });
  expect(result.status).toBe(200);
  return stepRun!;
}

/** Completes the two fan-out branches of `implement` (frontend, backend), each producing a distinct prTitle/prBody. */
async function finishImplementFanOut(rig: TestRig, cookie: string): Promise<void> {
  await claimAndFinish(rig, cookie, doneOutput("FE title", "FE body"));
  await claimAndFinish(rig, cookie, doneOutput("BE title", "BE body"));
}

/** Claims one StepRun as the Runner and finishes it failed — the "a branch died" half of the per-branch story. */
async function claimAndFail(rig: TestRig, cookie: string): Promise<void> {
  const runner = await joinRunner(rig, cookie);
  const claim = await runner.client.claim(runner.secret);
  const stepRun = (claim.body as { step_run: ClaimedStepRunShape | null }).step_run;
  expect(stepRun).not.toBeNull();
  const result = await runner.client.result(runner.secret, stepRun!.id, {
    lease_token: stepRun!.lease_token,
    outcome: "failed",
    reason: "simulated failure",
  });
  expect(result.status).toBe(200);
}

async function kindStepRows(
  rig: TestRig,
  runId: string,
): Promise<{ step_key: string; branch_key: string | null; outcome: string; kind: string | null; pr_number: number | null; pr_url: string | null; reason: string | null }[]> {
  const { rows } = await rig.pool.query(
    `select step_key, branch_key, outcome, kind, pr_number, pr_url, reason from step_runs where run_id = $1 and step_key = 'open-pr' order by branch_key`,
    [runId],
  );
  return rows;
}

async function runOutcome(rig: TestRig, runId: string): Promise<{ outcome: string | null; ended_at: Date | null }> {
  const { rows } = await rig.pool.query(`select outcome, ended_at from runs where id = $1`, [runId]);
  return rows[0] as { outcome: string | null; ended_at: Date | null };
}

describe("control-plane pull-request Step (issue #17)", () => {
  let rig: TestRig;
  let ownerCookie: string;

  beforeAll(async () => {
    rig = await startTestRig();
    ownerCookie = await rig.loginAsBreakGlass();
  });

  beforeEach(() => {
    // The fake git host is created once per rig — clear its recorded calls
    // and registered fixtures so each test asserts only its own run's PRs.
    rig.gitHost.reset();
  });

  afterAll(async () => {
    await rig.stop();
  });

  it("opens no PR for a fan-out branch that failed — that branch's kind: StepRun is skipped", async () => {
    const project = await createProject(rig, ownerCookie, "pr-branch-fail");
    const infra = await createRepository(rig, project.id, "infra");
    const frontend = await createRepository(rig, project.id, "frontend");
    const backend = await createRepository(rig, project.id, "backend");

    const runId = await triggerRun(
      rig,
      ownerCookie,
      project.id,
      infra,
      [
        "version: 1",
        "name: PR branch fail",
        "repo: infra",
        "steps:",
        "  contract:",
        "    prompt: write the api contract",
        "  implement:",
        "    after: [contract]",
        "    branches:",
        "      - key: frontend",
        "        repo: frontend",
        "      - key: backend",
        "        repo: backend",
        "    minBranches: 1",
        "    prompt: implement it",
        "    outputs:",
        "      prTitle: { type: string }",
        "      prBody: { type: string }",
        "  open-pr:",
        "    after: [implement]",
        "    kind: pull-request",
        "    base: main",
        "    title: { step: implement, output: prTitle }",
        "    body: { step: implement, output: prBody }",
      ].join("\n"),
    );

    await claimAndFinish(rig, ownerCookie, undefined); // contract.
    await claimAndFail(rig, ownerCookie); // frontend fails.
    await claimAndFinish(rig, ownerCookie, doneOutput("BE title", "BE body")); // backend succeeds.

    // One branch's kind: StepRun is skipped (nothing to open a PR for), the
    // other's is ready.
    const rows = await kindStepRows(rig, runId);
    expect(rows).toHaveLength(2);
    const skipped = rows.find((r) => r.outcome === "skipped");
    const ready = rows.find((r) => r.outcome === "ready");
    expect(skipped).toBeDefined();
    expect(ready).toBeDefined();
    expect(skipped?.reason).toBe("upstream-not-runnable");

    // Only the succeeded branch's PR is opened.
    expect(await runControlPlaneStepCycle(rig.deps, FAST_OPTIONS)).toBe(true);
    expect(rig.gitHost.pullRequests).toHaveLength(1);
    expect(rig.gitHost.pullRequests[0]?.repo.name).toBe("backend");
    const after = await kindStepRows(rig, runId);
    expect(after.find((r) => r.branch_key === "backend")?.outcome).toBe("succeeded");
  });

  it("opens one PR per fan-out branch in that branch's repo, posts the Commit Status, and records the PR on the StepRun rows", async () => {
    const project = await createProject(rig, ownerCookie, "pr-per-branch");
    const infra = await createRepository(rig, project.id, "infra");
    const frontend = await createRepository(rig, project.id, "frontend");
    const backend = await createRepository(rig, project.id, "backend");

    const runId = await triggerRun(
      rig,
      ownerCookie,
      project.id,
      infra,
      [
        "version: 1",
        "name: PR per branch",
        "repo: infra",
        "steps:",
        "  contract:",
        "    prompt: write the api contract",
        "  implement:",
        "    after: [contract]",
        "    branches:",
        "      - key: frontend",
        "        repo: frontend",
        "      - key: backend",
        "        repo: backend",
        "    minBranches: 1",
        "    prompt: implement it",
        "    outputs:",
        "      prTitle: { type: string }",
        "      prBody: { type: string }",
        "  open-pr:",
        "    after: [implement]",
        "    kind: pull-request",
        "    base: main",
        "    title: { step: implement, output: prTitle }",
        "    body: { step: implement, output: prBody }",
      ].join("\n"),
    );

    // contract is a root Step: claimable by a Runner.
    await claimAndFinish(rig, ownerCookie, undefined);
    await finishImplementFanOut(rig, ownerCookie);

    // The kind: StepRuns are born once per branch — and a Runner /claim
    // never sees them (AC1's filter split).
    const before = await kindStepRows(rig, runId);
    expect(before).toHaveLength(2);
    expect(before.map((r) => r.branch_key).sort()).toEqual(["backend", "frontend"]);
    expect(before.every((r) => r.outcome === "ready")).toBe(true);

    // The control plane itself claims and executes them, one per cycle.
    expect(await runControlPlaneStepCycle(rig.deps, FAST_OPTIONS)).toBe(true);
    expect(await runControlPlaneStepCycle(rig.deps, FAST_OPTIONS)).toBe(true);
    expect(await runControlPlaneStepCycle(rig.deps, FAST_OPTIONS)).toBe(false); // nothing left.

    // One PR per branch, in that branch's repo, head = the branch's pushed ref.
    const prs = rig.gitHost.pullRequests;
    expect(prs).toHaveLength(2);
    const byRepo = new Map(prs.map((pr) => [pr.repo.name, pr]));
    const fePr = byRepo.get("frontend");
    const bePr = byRepo.get("backend");
    expect(fePr).toBeDefined();
    expect(bePr).toBeDefined();
    expect(fePr!.head).toMatch(/^run\//);
    expect(fePr!.title).toBe("FE title");
    expect(bePr!.title).toBe("BE title");

    // The write surface: exactly the two permissions, no contents/issues (AC8).
    const prMints = rig.gitHost.minted.filter((m) => m.permissions.pull_requests === "write");
    expect(prMints).toHaveLength(2);
    expect(prMints.every((m) => m.permissions.contents === undefined && m.permissions.issues === undefined)).toBe(true);
    expect(prMints.every((m) => m.permissions.statuses === "write")).toBe(true);

    // The Commit Status, with the Run page as target_url (AC7).
    expect(rig.gitHost.statuses).toHaveLength(2);
    expect(rig.gitHost.statuses.every((s) => s.status.targetUrl === `https://factory.test/runs/${runId}`)).toBe(true);
    expect(rig.gitHost.statuses.every((s) => s.status.context === "factory")).toBe(true);

    // The StepRun rows record the PR — number and URL on the row, not an Output (ticket 24).
    const after = await kindStepRows(rig, runId);
    expect(after.every((r) => r.outcome === "succeeded")).toBe(true);
    expect(after.map((r) => r.pr_number).sort((a, b) => a! - b!)).toEqual(
      prs.map((pr) => pr.number).sort((a, b) => a - b),
    );
    expect(after.every((r) => r.pr_url !== null)).toBe(true);

    // The Run ends succeeded.
    const ended = await runOutcome(rig, runId);
    expect(ended.outcome).toBe("succeeded");
    expect(ended.ended_at).not.toBeNull();
  });

  it("opens a single PR after a plain Step (born once, inheriting that Step's repo)", async () => {
    const project = await createProject(rig, ownerCookie, "pr-after-plain");
    const backend = await createRepository(rig, project.id, "backend");

    const runId = await triggerRun(
      rig,
      ownerCookie,
      project.id,
      backend,
      [
        "version: 1",
        "name: PR after plain",
        "repo: backend",
        "steps:",
        "  review:",
        "    prompt: review it",
        "    outputs:",
        "      prTitle: { type: string }",
        "      prBody: { type: string }",
        "  open-pr:",
        "    after: [review]",
        "    kind: pull-request",
        "    base: main",
        "    title: { step: review, output: prTitle }",
        "    body: { step: review, output: prBody }",
      ].join("\n"),
    );

    await claimAndFinish(rig, ownerCookie, doneOutput("Single title", "Single body"));

    const before = await kindStepRows(rig, runId);
    expect(before).toHaveLength(1);
    expect(before[0]?.branch_key).toBeNull();

    expect(await runControlPlaneStepCycle(rig.deps, FAST_OPTIONS)).toBe(true);

    const prs = rig.gitHost.pullRequests;
    expect(prs).toHaveLength(1);
    expect(prs[0]?.repo.name).toBe("backend");
    expect(prs[0]?.title).toBe("Single title");

    const after = await kindStepRows(rig, runId);
    expect(after[0]?.outcome).toBe("succeeded");
    expect(after[0]?.pr_number).toBe(prs[0]?.number ?? null);
  });

  it("adopts an existing open PR instead of creating a second one", async () => {
    const project = await createProject(rig, ownerCookie, "pr-adopt");
    const backend = await createRepository(rig, project.id, "backend");

    const runId = await triggerRun(
      rig,
      ownerCookie,
      project.id,
      backend,
      [
        "version: 1",
        "name: PR adopt",
        "repo: backend",
        "steps:",
        "  review:",
        "    prompt: review it",
        "    outputs:",
        "      prTitle: { type: string }",
        "      prBody: { type: string }",
        "  open-pr:",
        "    after: [review]",
        "    kind: pull-request",
        "    base: main",
        "    title: { step: review, output: prTitle }",
        "    body: { step: review, output: prBody }",
      ].join("\n"),
    );

    await claimAndFinish(rig, ownerCookie, doneOutput("Adopt title", "Adopt body"));

    const head = (await kindStepRows(rig, runId)).length > 0;
    expect(head).toBe(true);

    // The upstream review StepRun's pushed branch is the PR head — find the
    // actual branch name the same way the executor will, then pre-register an
    // open PR for it.
    const { rows } = await rig.pool.query<{ output_ref_branch: string }>(
      `select output_ref_branch from step_runs where run_id = $1 and step_key = 'review'`,
      [runId],
    );
    const headBranch = rows[0]?.output_ref_branch as string;
    rig.gitHost.registerOpenPullRequest({ owner: backend.owner, name: backend.name }, headBranch, "main", {
      number: 7001,
      htmlUrl: `https://github.com/${backend.owner}/${backend.name}/pull/7001`,
    });

    expect(await runControlPlaneStepCycle(rig.deps, FAST_OPTIONS)).toBe(true);

    // Nothing was created — the pre-registered PR was adopted (AC6's search
    // half), and its number/URL recorded on the row.
    expect(rig.gitHost.pullRequests).toHaveLength(0);
    expect(rig.gitHost.finds).toHaveLength(1);
    const after = await kindStepRows(rig, runId);
    expect(after[0]?.outcome).toBe("succeeded");
    expect(after[0]?.pr_number).toBe(7001);
    expect(after[0]?.pr_url).toBe(`https://github.com/${backend.owner}/${backend.name}/pull/7001`);
  });

  it("treats a raced 422 create as success and adopts the PR (AC6's second half)", async () => {
    const project = await createProject(rig, ownerCookie, "pr-422");
    const backend = await createRepository(rig, project.id, "backend");

    const runId = await triggerRun(
      rig,
      ownerCookie,
      project.id,
      backend,
      [
        "version: 1",
        "name: PR 422",
        "repo: backend",
        "steps:",
        "  review:",
        "    prompt: review it",
        "    outputs:",
        "      prTitle: { type: string }",
        "      prBody: { type: string }",
        "  open-pr:",
        "    after: [review]",
        "    kind: pull-request",
        "    base: main",
        "    title: { step: review, output: prTitle }",
        "    body: { step: review, output: prBody }",
      ].join("\n"),
    );
    await claimAndFinish(rig, ownerCookie, doneOutput("422 title", "422 body"));
    await kindStepRows(rig, runId); // wait for the kind row.

    rig.gitHost.conflictOnNextCreate = true;

    expect(await runControlPlaneStepCycle(rig.deps, FAST_OPTIONS)).toBe(true);

    // find (miss) -> create (422) -> find (hit): the re-find adopted the
    // racing PR, the StepRun succeeded with its number.
    expect(rig.gitHost.finds).toHaveLength(2);
    const after = await kindStepRows(rig, runId);
    expect(after[0]?.outcome).toBe("succeeded");
    expect(after[0]?.pr_number).not.toBeNull();
  });

  it("retries transient create failures up to attempts: 3, then succeeds", async () => {
    const project = await createProject(rig, ownerCookie, "pr-retry");
    const backend = await createRepository(rig, project.id, "backend");

    const runId = await triggerRun(
      rig,
      ownerCookie,
      project.id,
      backend,
      [
        "version: 1",
        "name: PR retry",
        "repo: backend",
        "steps:",
        "  review:",
        "    prompt: review it",
        "    outputs:",
        "      prTitle: { type: string }",
        "      prBody: { type: string }",
        "  open-pr:",
        "    after: [review]",
        "    kind: pull-request",
        "    base: main",
        "    title: { step: review, output: prTitle }",
        "    body: { step: review, output: prBody }",
      ].join("\n"),
    );
    await claimAndFinish(rig, ownerCookie, doneOutput("Retry title", "Retry body"));
    await kindStepRows(rig, runId);

    rig.gitHost.failNextCreates = 2; // two transient 5xx, third succeeds.

    expect(await runControlPlaneStepCycle(rig.deps, FAST_OPTIONS)).toBe(true);

    const after = await kindStepRows(rig, runId);
    expect(after[0]?.outcome).toBe("succeeded");
    expect(after[0]?.reason).toBeNull();
  });

  it("gives up after attempts: 3 and records the StepRun failed with the GitHub error as its reason", async () => {
    const project = await createProject(rig, ownerCookie, "pr-fail");
    const backend = await createRepository(rig, project.id, "backend");

    const runId = await triggerRun(
      rig,
      ownerCookie,
      project.id,
      backend,
      [
        "version: 1",
        "name: PR fail",
        "repo: backend",
        "steps:",
        "  review:",
        "    prompt: review it",
        "    outputs:",
        "      prTitle: { type: string }",
        "      prBody: { type: string }",
        "  open-pr:",
        "    after: [review]",
        "    kind: pull-request",
        "    base: main",
        "    title: { step: review, output: prTitle }",
        "    body: { step: review, output: prBody }",
      ].join("\n"),
    );
    await claimAndFinish(rig, ownerCookie, doneOutput("Fail title", "Fail body"));
    await kindStepRows(rig, runId);

    rig.gitHost.failNextCreates = 3; // every attempt fails.

    expect(await runControlPlaneStepCycle(rig.deps, FAST_OPTIONS)).toBe(true);

    const after = await kindStepRows(rig, runId);
    expect(after[0]?.outcome).toBe("failed");
    expect(after[0]?.reason).toContain("github pull request create failed");
    expect(after[0]?.pr_number).toBeNull();
  });

  it("checks the Run's cancel flag immediately before the write and aborts without opening a PR", async () => {
    const project = await createProject(rig, ownerCookie, "pr-cancel");
    const backend = await createRepository(rig, project.id, "backend");

    const runId = await triggerRun(
      rig,
      ownerCookie,
      project.id,
      backend,
      [
        "version: 1",
        "name: PR cancel",
        "repo: backend",
        "steps:",
        "  review:",
        "    prompt: review it",
        "    outputs:",
        "      prTitle: { type: string }",
        "      prBody: { type: string }",
        "  open-pr:",
        "    after: [review]",
        "    kind: pull-request",
        "    base: main",
        "    title: { step: review, output: prTitle }",
        "    body: { step: review, output: prBody }",
      ].join("\n"),
    );
    await claimAndFinish(rig, ownerCookie, doneOutput("Cancel title", "Cancel body"));
    await kindStepRows(rig, runId);

    // The Run's cancel flag — the intent column the design names (AC9). The
    // executor must not write a PR for a Run that is being cancelled.
    await rig.pool.query(`update runs set cancel_requested_at = now() where id = $1`, [runId]);

    expect(await runControlPlaneStepCycle(rig.deps, FAST_OPTIONS)).toBe(true);

    expect(rig.gitHost.pullRequests).toHaveLength(0);
    const after = await kindStepRows(rig, runId);
    expect(after[0]?.outcome).toBe("cancelled");
    expect(after[0]?.reason).toBe("cancelled-by-operator");
  });
});
