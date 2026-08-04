/**
 * Acceptance criteria under test (issue #4): a Pipeline definition read from
 * the *triggered* ref, validated, and materialized into a Run + initial
 * Graph — or rejected before any row exists. Exercised over real HTTP
 * against a real migrated Postgres, with `GitHost` faked (see
 * `fake-git-host.ts`) so nothing here dials out to github.com.
 *
 * Reuses the actual prototype fixtures from `@factory/shared`'s pipeline
 * test suite (read straight off disk, not copied) for the "prototype files
 * parse and materialize correctly" criterion — see `readSharedFixture`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateId } from "@factory/shared";
import { startTestRig, type TestRig } from "./setup.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SHARED_FIXTURES_DIR = path.resolve(here, "../../../shared/src/pipeline/__fixtures__");

function readSharedFixture(name: string): string {
  return readFileSync(path.join(SHARED_FIXTURES_DIR, name), "utf-8");
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

/**
 * Inserts `repositories` (and its required `github_app_installations`
 * parent) directly — issue #4 has no Repository CRUD surface of its own.
 * `owner` is generated fresh per call: `repositories_owner_name_key` is a
 * *global* unique index (a GitHub owner/repo pair belongs to exactly one
 * Project system-wide), so two Projects reusing the same owner while
 * wanting the same `name` (e.g. both wanting "backend" to match a
 * fixture's `repo:` field) would otherwise collide across tests.
 */
async function createRepository(rig: TestRig, projectId: string, name: string): Promise<{ id: string; owner: string; name: string }> {
  repoCounter += 1;
  const owner = `acme-${repoCounter}`;
  const installationRowId = generateId("installation");
  await rig.pool.query(
    "insert into github_app_installations (id, project_id, installation_id, account_login) values ($1, $2, $3, $4)",
    [installationRowId, projectId, 1_000_000 + repoCounter, owner],
  );
  const repositoryId = generateId("repository");
  await rig.pool.query(
    "insert into repositories (id, project_id, github_app_installation_id, owner, name, default_branch) values ($1, $2, $3, $4, $5, 'main')",
    [repositoryId, projectId, installationRowId, owner, name],
  );
  return { id: repositoryId, owner, name };
}

interface TriggerResponse {
  run: { id: string; refSha: string; refBranch: string };
  stepRuns: { id: string; stepKey: string; outcome: string; branchKey: string | null; requiredTags: string[] }[];
}

async function trigger(
  rig: TestRig,
  cookie: string,
  projectId: string,
  body: { id: string; repositoryId: string; pipelinePath: string; refBranch: string },
): Promise<Response> {
  return rig.fetchWithCsrf(`${rig.baseUrl}/projects/${projectId}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}

describe("Pipeline trigger and Graph materialization", () => {
  let rig: TestRig;
  let ownerCookie: string;

  beforeAll(async () => {
    rig = await startTestRig();
    ownerCookie = await rig.loginAsBreakGlass();
  });

  afterAll(async () => {
    await rig.stop();
  });

  it("materializes only the root Steps of a linear (non-fan-out) prototype fixture, in one call", async () => {
    const project = await createProject(rig, ownerCookie, "linear-project");
    const repo = await createRepository(rig, project.id, "frontend");
    const yaml = readSharedFixture("d-verdict-02-linear.yaml");
    rig.gitHost.registerRef(repo, "main", "sha-linear-1");
    rig.gitHost.registerFile(repo, "sha-linear-1", ".factory/pipeline.yaml", yaml);

    const runId = generateId("run");
    const response = await trigger(rig, ownerCookie, project.id, {
      id: runId,
      repositoryId: repo.id,
      pipelinePath: ".factory/pipeline.yaml",
      refBranch: "main",
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as TriggerResponse;
    expect(body.run.refSha).toBe("sha-linear-1");
    // Only `lint` (after: []) materializes — `build` and `test` are behind
    // an unmet dependency and must not exist yet.
    expect(body.stepRuns).toHaveLength(1);
    expect(body.stepRuns[0]).toMatchObject({ stepKey: "lint", outcome: "ready", branchKey: null, requiredTags: [] });

    const { rows } = await rig.pool.query("select step_key from step_runs where run_id = $1", [runId]);
    expect(rows.map((r: { step_key: string }) => r.step_key)).toEqual(["lint"]);
  });

  it("materializes only the pre-fan-out root of a fan-out prototype fixture (d-verdict-01)", async () => {
    const project = await createProject(rig, ownerCookie, "fanout-project");
    const repo = await createRepository(rig, project.id, "backend");
    const yaml = readSharedFixture("d-verdict-01-fanout-review.yaml");
    rig.gitHost.registerRef(repo, "main", "sha-fanout-1");
    rig.gitHost.registerFile(repo, "sha-fanout-1", ".factory/pipeline.yaml", yaml);
    // Every promptFile the definition references gets captured, not just
    // the ones behind materializable Steps — `plan` is the only Step that
    // materializes here, but `implement`/`pick-best`/`review`'s prompt
    // files must still be read now so the Run's copy survives fan-out
    // happening later against a ref that may no longer exist.
    rig.gitHost.registerFile(repo, "sha-fanout-1", ".factory/prompts/plan.md", "plan the work");
    rig.gitHost.registerFile(repo, "sha-fanout-1", ".factory/prompts/implement.md", "implement the plan");
    rig.gitHost.registerFile(repo, "sha-fanout-1", ".factory/prompts/pick-best.md", "pick the best branch");
    rig.gitHost.registerFile(repo, "sha-fanout-1", ".factory/prompts/review.md", "review the result");

    const runId = generateId("run");
    const response = await trigger(rig, ownerCookie, project.id, {
      id: runId,
      repositoryId: repo.id,
      pipelinePath: ".factory/pipeline.yaml",
      refBranch: "main",
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as TriggerResponse;
    // `implement` (branches:), `pick-best`, `review`, `test` are all behind
    // the fan-out and must not materialize here (issue #11's job).
    expect(body.stepRuns.map((s) => s.stepKey)).toEqual(["plan"]);
  });

  it("materializes only the pre-fan-out root of a cross-repo prototype fixture (d-verdict-03)", async () => {
    const project = await createProject(rig, ownerCookie, "cross-repo-project");
    const repo = await createRepository(rig, project.id, "infra");
    const yaml = readSharedFixture("d-verdict-03-cross-repo.yaml");
    rig.gitHost.registerRef(repo, "main", "sha-cross-1");
    rig.gitHost.registerFile(repo, "sha-cross-1", ".factory/pipeline.yaml", yaml);
    rig.gitHost.registerFile(repo, "sha-cross-1", "prompts/api-contract.md", "design the contract");
    rig.gitHost.registerFile(repo, "sha-cross-1", "prompts/implement-from-contract.md", "implement from the contract");
    rig.gitHost.registerFile(repo, "sha-cross-1", "prompts/report.md", "report the outcome");

    const runId = generateId("run");
    const response = await trigger(rig, ownerCookie, project.id, {
      id: runId,
      repositoryId: repo.id,
      pipelinePath: ".factory/pipeline.yaml",
      refBranch: "main",
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as TriggerResponse;
    expect(body.stepRuns.map((s) => s.stepKey)).toEqual(["contract"]);
  });

  it("materializes every independent root Step, not just the first (two-root definition)", async () => {
    const project = await createProject(rig, ownerCookie, "two-root-project");
    const repo = await createRepository(rig, project.id, "backend");
    const yaml = `version: 1
name: Two independent roots
repo: backend
steps:
  a:
    run: echo a
  b:
    run: echo b
  c:
    after: [a, b]
    run: echo c
`;
    rig.gitHost.registerRef(repo, "main", "sha-two-root-1");
    rig.gitHost.registerFile(repo, "sha-two-root-1", ".factory/pipeline.yaml", yaml);

    const runId = generateId("run");
    const response = await trigger(rig, ownerCookie, project.id, {
      id: runId,
      repositoryId: repo.id,
      pipelinePath: ".factory/pipeline.yaml",
      refBranch: "main",
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as TriggerResponse;
    expect(new Set(body.stepRuns.map((s) => s.stepKey))).toEqual(new Set(["a", "b"]));

    const { rows } = await rig.pool.query("select step_key from step_runs where run_id = $1 order by step_key", [
      runId,
    ]);
    expect(rows.map((r: { step_key: string }) => r.step_key)).toEqual(["a", "b"]);
  });

  it("reads the definition from the triggered ref, not the default branch", async () => {
    const project = await createProject(rig, ownerCookie, "ref-project");
    const repo = await createRepository(rig, project.id, "reftest");

    rig.gitHost.registerRef(repo, "main", "sha-main");
    rig.gitHost.registerFile(
      repo,
      "sha-main",
      ".factory/pipeline.yaml",
      "version: 1\nname: on main\nrepo: reftest\nsteps:\n  onlyOnMain:\n    run: echo main\n",
    );
    rig.gitHost.registerRef(repo, "feature", "sha-feature");
    rig.gitHost.registerFile(
      repo,
      "sha-feature",
      ".factory/pipeline.yaml",
      "version: 1\nname: on feature\nrepo: reftest\nsteps:\n  onlyOnFeature:\n    run: echo feature\n",
    );

    const runId = generateId("run");
    const response = await trigger(rig, ownerCookie, project.id, {
      id: runId,
      repositoryId: repo.id,
      pipelinePath: ".factory/pipeline.yaml",
      refBranch: "feature",
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as TriggerResponse;
    expect(body.run.refSha).toBe("sha-feature");
    expect(body.stepRuns.map((s) => s.stepKey)).toEqual(["onlyOnFeature"]);
  });

  it("rejects an invalid definition (cyclic Graph) before any Run or StepRun row is born", async () => {
    const project = await createProject(rig, ownerCookie, "invalid-project");
    const repo = await createRepository(rig, project.id, "backend");
    const yaml = readSharedFixture("reject-cyclic-graph.yaml");
    rig.gitHost.registerRef(repo, "main", "sha-invalid-1");
    rig.gitHost.registerFile(repo, "sha-invalid-1", ".factory/pipeline.yaml", yaml);

    const runId = generateId("run");
    const response = await trigger(rig, ownerCookie, project.id, {
      id: runId,
      repositoryId: repo.id,
      pipelinePath: ".factory/pipeline.yaml",
      refBranch: "main",
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string; message: string };
    expect(body.code).toBe("pipeline_definition_invalid");
    expect(body.message.toLowerCase()).toContain("cyclic");

    const { rows: runRows } = await rig.pool.query("select 1 from runs where id = $1", [runId]);
    expect(runRows).toHaveLength(0);
    const { rows: stepRunRows } = await rig.pool.query("select 1 from step_runs where run_id = $1", [runId]);
    expect(stepRunRows).toHaveLength(0);
  });

  it("rejects a definition whose combined YAML + prompt file size exceeds the inline storage limit", async () => {
    const project = await createProject(rig, ownerCookie, "too-large-project");
    const repo = await createRepository(rig, project.id, "backend");
    const yaml = `version: 1
name: Too large
repo: backend
steps:
  plan:
    promptFile: .factory/prompts/plan.md
    outputs:
      x: { type: string }
`;
    rig.gitHost.registerRef(repo, "main", "sha-large-1");
    rig.gitHost.registerFile(repo, "sha-large-1", ".factory/pipeline.yaml", yaml);
    rig.gitHost.registerFile(
      repo,
      "sha-large-1",
      ".factory/prompts/plan.md",
      "x".repeat(3 * 1024 * 1024),
    );

    const runId = generateId("run");
    const response = await trigger(rig, ownerCookie, project.id, {
      id: runId,
      repositoryId: repo.id,
      pipelinePath: ".factory/pipeline.yaml",
      refBranch: "main",
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("pipeline_definition_too_large");

    const { rows } = await rig.pool.query("select 1 from runs where id = $1", [runId]);
    expect(rows).toHaveLength(0);
  });

  it("rejects a double-triggered (repeated client id) Run by the primary key, not a guard, with no duplicate row", async () => {
    const project = await createProject(rig, ownerCookie, "double-click-project");
    const repo = await createRepository(rig, project.id, "backend");
    const yaml = "version: 1\nname: solo\nrepo: backend\nsteps:\n  solo:\n    run: echo solo\n";
    rig.gitHost.registerRef(repo, "main", "sha-double-1");
    rig.gitHost.registerFile(repo, "sha-double-1", ".factory/pipeline.yaml", yaml);

    const runId = generateId("run");
    const requestBody = {
      id: runId,
      repositoryId: repo.id,
      pipelinePath: ".factory/pipeline.yaml",
      refBranch: "main",
    };

    const first = await trigger(rig, ownerCookie, project.id, requestBody);
    expect(first.status).toBe(201);

    const second = await trigger(rig, ownerCookie, project.id, requestBody);
    expect(second.status).toBe(400);
    const secondBody = (await second.json()) as { code: string };
    expect(secondBody.code).toBe("run_id_conflict");

    const { rows } = await rig.pool.query("select count(*)::int as count from runs where id = $1", [runId]);
    expect(rows[0].count).toBe(1);
  });

  it("GET /projects/{id}/runs/{runId} returns the Run's own copy of the definition and prompt files", async () => {
    const project = await createProject(rig, ownerCookie, "get-run-project");
    const repo = await createRepository(rig, project.id, "backend");
    const yaml = `version: 1
name: with prompt
repo: backend
steps:
  plan:
    promptFile: .factory/prompts/plan.md
    outputs:
      x: { type: string }
`;
    rig.gitHost.registerRef(repo, "main", "sha-get-1");
    rig.gitHost.registerFile(repo, "sha-get-1", ".factory/pipeline.yaml", yaml);
    rig.gitHost.registerFile(
      repo,
      "sha-get-1",
      ".factory/prompts/plan.md",
      "plan the work, verbatim",
    );

    const runId = generateId("run");
    await trigger(rig, ownerCookie, project.id, {
      id: runId,
      repositoryId: repo.id,
      pipelinePath: ".factory/pipeline.yaml",
      refBranch: "main",
    });

    const response = await rig.fetchWithCsrf(`${rig.baseUrl}/projects/${project.id}/runs/${runId}`, {
      headers: { cookie: ownerCookie },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      run: { definition: string; definitionFiles: Record<string, string> };
      stepRuns: unknown[];
    };
    expect(body.run.definition).toBe(yaml);
    expect(body.run.definitionFiles[".factory/prompts/plan.md"]).toBe("plan the work, verbatim");
  });

  it("lists Runs newest-first with keyset pagination and distinguishes in-flight from a final-verdict filter", async () => {
    const project = await createProject(rig, ownerCookie, "list-project");
    const repo = await createRepository(rig, project.id, "backend");
    const yaml = "version: 1\nname: solo\nrepo: backend\nsteps:\n  solo:\n    run: echo solo\n";
    rig.gitHost.registerRef(repo, "main", "sha-list-1");
    rig.gitHost.registerFile(repo, "sha-list-1", ".factory/pipeline.yaml", yaml);

    const runIds = [generateId("run"), generateId("run"), generateId("run")].sort();
    for (const id of runIds) {
      const response = await trigger(rig, ownerCookie, project.id, {
        id,
        repositoryId: repo.id,
        pipelinePath: ".factory/pipeline.yaml",
        refBranch: "main",
      });
      expect(response.status).toBe(201);
    }

    const firstPage = await rig.fetchWithCsrf(`${rig.baseUrl}/projects/${project.id}/runs?limit=2`, {
      headers: { cookie: ownerCookie },
    });
    const firstBody = (await firstPage.json()) as { runs: { id: string }[]; nextCursor: string | null };
    expect(firstBody.runs.map((r) => r.id)).toEqual([runIds[2], runIds[1]]);
    expect(firstBody.nextCursor).toBe(runIds[1]);

    const secondPage = await rig.fetchWithCsrf(
      `${rig.baseUrl}/projects/${project.id}/runs?limit=2&cursor=${firstBody.nextCursor}`,
      { headers: { cookie: ownerCookie } },
    );
    const secondBody = (await secondPage.json()) as { runs: { id: string }[]; nextCursor: string | null };
    expect(secondBody.runs.map((r) => r.id)).toEqual([runIds[0]]);
    expect(secondBody.nextCursor).toBeNull();

    // No `total` field anywhere in the envelope — no total count (spec: "tanpa total count").
    expect(firstBody).not.toHaveProperty("total");

    // `ended_at IS NULL` and `outcome = ...` are distinct, non-overlapping filters: nothing has ended yet in this
    // issue's scope, so every Run is in flight and none has a final verdict.
    const inFlight = await rig.fetchWithCsrf(`${rig.baseUrl}/projects/${project.id}/runs?inFlight=true`, {
      headers: { cookie: ownerCookie },
    });
    const inFlightBody = (await inFlight.json()) as { runs: { id: string }[] };
    expect(inFlightBody.runs).toHaveLength(3);

    const succeeded = await rig.fetchWithCsrf(`${rig.baseUrl}/projects/${project.id}/runs?outcome=succeeded`, {
      headers: { cookie: ownerCookie },
    });
    const succeededBody = (await succeeded.json()) as { runs: { id: string }[] };
    expect(succeededBody.runs).toHaveLength(0);
  });

  it("rejects a Step repo: that does not name a Repository of this Project", async () => {
    const project = await createProject(rig, ownerCookie, "unknown-repo-project");
    const repo = await createRepository(rig, project.id, "host-repo");
    const yaml = "version: 1\nname: solo\nrepo: not-a-real-repo\nsteps:\n  solo:\n    run: echo solo\n";
    rig.gitHost.registerRef(repo, "main", "sha-unknown-1");
    rig.gitHost.registerFile(repo, "sha-unknown-1", ".factory/pipeline.yaml", yaml);

    const runId = generateId("run");
    const response = await trigger(rig, ownerCookie, project.id, {
      id: runId,
      repositoryId: repo.id,
      pipelinePath: ".factory/pipeline.yaml",
      refBranch: "main",
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("step_repository_not_found");
  });

  it("a non-member of the Project cannot trigger a Run in it", async () => {
    const project = await createProject(rig, ownerCookie, "outsider-project");
    const repo = await createRepository(rig, project.id, "backend");
    const outsiderCookie = await rig.loginAsGithub({
      githubUserId: 9001,
      githubLogin: "outsider",
      name: null,
      avatarUrl: null,
    });

    const response = await trigger(rig, outsiderCookie, project.id, {
      id: generateId("run"),
      repositoryId: repo.id,
      pipelinePath: ".factory/pipeline.yaml",
      refBranch: "main",
    });

    expect(response.status).toBe(403);
  });
});
