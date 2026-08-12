/**
 * Issue #20's visual Pipeline editor, end to end over the seam-1 rig: a
 * Project `member` submits a serialized Pipeline definition, and the control
 * plane opens a PR in the host repository — with the user's GitHub identity
 * as commit author, `factory[bot]` as committer, an ad-hoc installation
 * token that is minted, used, and revoked, and no audit event.
 *
 * What this file proves (issue #20's acceptance criteria):
 *  - the PR lands in the host repo only — the repository the request names
 *    must belong to the Project, and every GitHub call is scoped to it (AC1);
 *  - `author` is `<githubUserId>+<githubLogin>@users.noreply.github.com` and
 *    `committer` is the bot identity (AC2);
 *  - the minted token carries exactly `{ contents, pull_requests }` for the
 *    host repo, is revoked after the operation, and no User token is ever
 *    minted or stored (AC3);
 *  - the commit is written through the Contents API (`writeFile`), not a
 *    local clone (AC4);
 *  - invalid definitions are rejected with the shared Zod schema's issues
 *    before any GitHub call (AC6);
 *  - `member` is sufficient — a non-member gets 403 (AC7);
 *  - no audit event is recorded — the PR is itself the attributed record (AC8);
 *  - a retried request with the same `editId` re-uses the same branch and
 *    adopts the same PR (the issue #17 422-as-success rule).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestRig, type TestRig } from "./setup.js";

let rig: TestRig;

beforeAll(async () => {
  rig = await startTestRig();
});

afterAll(async () => {
  await rig.stop();
});

beforeEach(() => {
  rig.gitHost.reset();
});

let repoCounter = 2000;

async function createProject(testRig: TestRig, cookie: string, name: string): Promise<{ id: string }> {
  const response = await testRig.fetchWithCsrf(`${testRig.baseUrl}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string };
}

async function createRepository(
  testRig: TestRig,
  projectId: string,
  name: string,
): Promise<{ id: string; owner: string; name: string }> {
  repoCounter += 1;
  const owner = `editor-owner-${repoCounter}`;
  const installationRowId = `installation_${repoCounter}`;
  await testRig.pool.query(
    "insert into github_app_installations (id, project_id, installation_id, account_login) values ($1, $2, $3, $4)",
    [installationRowId, projectId, 20_000_000 + repoCounter, owner],
  );
  const repositoryId = `repository_${repoCounter}`;
  await testRig.pool.query(
    "insert into repositories (id, project_id, github_app_installation_id, owner, name, default_branch) values ($1, $2, $3, $4, $5, 'main')",
    [repositoryId, projectId, installationRowId, owner, name],
  );
  return { id: repositoryId, owner, name };
}

/** Logs in as a GitHub user and adds them as a Project `member`. Returns the cookie and the user's stored GitHub identity. */
async function memberUser(
  testRig: TestRig,
  githubUserId: number,
  githubLogin: string,
  projectId: string,
): Promise<{ cookie: string; githubUserId: number; githubLogin: string }> {
  const cookie = await testRig.loginAsGithub({ githubUserId, githubLogin, name: null, avatarUrl: null });
  const rows = await testRig.pool.query(
    "select principal_id, github_user_id, github_login from users where github_user_id = $1",
    [githubUserId],
  );
  const ownerCookie = await testRig.loginAsBreakGlass();
  const addResponse = await testRig.fetchWithCsrf(`${testRig.baseUrl}/projects/${projectId}/members`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: ownerCookie },
    body: JSON.stringify({ principalId: rows.rows[0]!.principal_id, role: "member" }),
  });
  expect(addResponse.status).toBe(200);
  return { cookie, githubUserId: rows.rows[0]!.github_user_id, githubLogin: rows.rows[0]!.github_login };
}

const VALID_YAML = `version: 1
name: Lint
repo: backend
steps:
  lint:
    run: pnpm lint
`;

function openEditorPullRequest(
  testRig: TestRig,
  cookie: string,
  projectId: string,
  body: { repositoryId: string; pipelinePath: string; yaml: string; editId: string },
): Promise<Response> {
  return testRig.fetchWithCsrf(`${testRig.baseUrl}/projects/${projectId}/pipeline-editor`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}

describe("the visual Pipeline editor (issue #20)", () => {
  let project: { id: string };
  let hostRepo: { id: string; owner: string; name: string };
  let user: { cookie: string; githubUserId: number; githubLogin: string };

  beforeAll(async () => {
    const ownerCookie = await rig.loginAsBreakGlass();
    project = await createProject(rig, ownerCookie, "editor-project");
    await rig.fetchWithCsrf(`${rig.baseUrl}/projects/${project.id}/members/self`, {
      method: "POST",
      headers: { cookie: ownerCookie },
    });
    hostRepo = await createRepository(rig, project.id, "backend");
    user = await memberUser(rig, 7001, "someone", project.id);
  });

  it("opens a PR in the host repo with user-authored, bot-committed attribution, a scoped minted token, a revoke, and no audit event (AC1-AC4, AC8)", async () => {
    const before = await rig.pool.query("select count(*)::int as n from audit_log");
    const response = await openEditorPullRequest(rig, user.cookie, project.id, {
      repositoryId: hostRepo.id,
      pipelinePath: ".factory/pipeline.yaml",
      yaml: VALID_YAML,
      editId: "edit_abc123",
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      prNumber: number;
      prUrl: string;
      headBranch: string;
      commitSha: string;
    };
    expect(body.prUrl).toContain(`https://github.com/${hostRepo.owner}/${hostRepo.name}/pull/`);
    expect(body.headBranch).toBe("factory/editor/edit_abc123");
    expect(body.commitSha).toMatch(/^content-sha-/);

    // Issue #39: the branch is cut from the repo's default branch before the
    // first write — the Contents API 404s on a branch that does not exist.
    expect(rig.gitHost.createdBranches).toEqual([
      {
        repo: { owner: hostRepo.owner, name: hostRepo.name },
        branch: "factory/editor/edit_abc123",
        base: "main",
      },
    ]);

    // AC4: the file write went through the Contents API surface, into the
    // host repo only (AC1), with the exact attribution split (AC2).
    expect(rig.gitHost.contents).toHaveLength(1);
    const write = rig.gitHost.contents[0]!;
    expect(write.repo).toEqual({ owner: hostRepo.owner, name: hostRepo.name });
    expect(write.path).toBe(".factory/pipeline.yaml");
    expect(write.branch).toBe("factory/editor/edit_abc123");
    expect(write.content).toBe(VALID_YAML);
    expect(write.message).toContain(".factory/pipeline.yaml");
    expect(write.author).toEqual({
      name: user.githubLogin,
      email: `${user.githubUserId}+${user.githubLogin}@users.noreply.github.com`,
    });
    expect(write.committer).toEqual({ name: "factory[bot]", email: "factory[bot]@users.noreply.github.com" });

    // AC3: one mint, scoped to the host repo with exactly the two editor
    // permissions — and no User token anywhere. Then the revoke (teardown).
    expect(rig.gitHost.minted).toHaveLength(1);
    expect(rig.gitHost.minted[0]!.repo).toEqual({ owner: hostRepo.owner, name: hostRepo.name });
    expect(rig.gitHost.minted[0]!.permissions).toEqual({ contents: "write", pull_requests: "write" });
    expect(rig.gitHost.revocations).toHaveLength(1);
    expect(rig.gitHost.revocations[0]!.token).toBe(rig.gitHost.minted[0]!.token);

    // The PR was opened from the editor branch onto the repo's default branch.
    expect(rig.gitHost.pullRequests).toHaveLength(1);
    expect(rig.gitHost.pullRequests[0]!.head).toBe("factory/editor/edit_abc123");
    expect(rig.gitHost.pullRequests[0]!.base).toBe("main");
    expect(rig.gitHost.pullRequests[0]!.title).toContain(".factory/pipeline.yaml");

    // AC8: no audit event — the PR itself is the permanent attributed record.
    const after = await rig.pool.query("select count(*)::int as n from audit_log");
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it("lists the host-repo candidates for the editor UI, scoped to the Project (AC1)", async () => {
    const otherRepo = await createRepository(rig, project.id, "other-repo");
    const response = await rig.fetchWithCsrf(`${rig.baseUrl}/projects/${project.id}/repositories`, {
      headers: { cookie: user.cookie },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { repositories: { id: string; owner: string; name: string }[] };
    const ids = body.repositories.map((r) => r.id).sort();
    expect(ids).toEqual([hostRepo.id, otherRepo.id].sort());
    expect(body.repositories.every((r) => r.name === "backend" || r.name === "other-repo")).toBe(true);
  });

  it("rejects an invalid definition with the shared Zod schema's issues before any GitHub call (AC6)", async () => {
    const invalid = `version: 1
name: broken
repo: backend
steps:
  lint:
    prompt: lint
    run: pnpm lint
`;
    const response = await openEditorPullRequest(rig, user.cookie, project.id, {
      repositoryId: hostRepo.id,
      pipelinePath: ".factory/pipeline.yaml",
      yaml: invalid,
      editId: "edit_invalid1",
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string; message: string };
    expect(body.code).toBe("pipeline_definition_invalid");
    expect(body.message).toContain("more than one was found");
    expect(rig.gitHost.minted).toHaveLength(0);
    expect(rig.gitHost.contents).toHaveLength(0);
    expect(rig.gitHost.revocations).toHaveLength(0);
  });

  it("requires the clicking user to have a GitHub identity — break-glass cannot be attributed (AC2)", async () => {
    const breakGlass = await rig.loginAsBreakGlass();
    const response = await openEditorPullRequest(rig, breakGlass, project.id, {
      repositoryId: hostRepo.id,
      pipelinePath: ".factory/pipeline.yaml",
      yaml: VALID_YAML,
      editId: "edit_breakglass",
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("github_identity_required");
    expect(rig.gitHost.minted).toHaveLength(0);
  });

  it("refuses a non-member with 403 (AC7: member is enough — and no more)", async () => {
    const outsider = await rig.loginAsGithub({ githubUserId: 7002, githubLogin: "outsider", name: null, avatarUrl: null });
    const response = await openEditorPullRequest(rig, outsider, project.id, {
      repositoryId: hostRepo.id,
      pipelinePath: ".factory/pipeline.yaml",
      yaml: VALID_YAML,
      editId: "edit_outsider",
    });
    expect(response.status).toBe(403);
    expect(rig.gitHost.minted).toHaveLength(0);
  });

  it("404s a repository that does not belong to the Project — the UI scope cannot be widened (AC1)", async () => {
    const otherProject = await createProject(rig, await rig.loginAsBreakGlass(), "other-project");
    const foreignRepo = await createRepository(rig, otherProject.id, "foreign");
    const response = await openEditorPullRequest(rig, user.cookie, project.id, {
      repositoryId: foreignRepo.id,
      pipelinePath: ".factory/pipeline.yaml",
      yaml: VALID_YAML,
      editId: "edit_foreign",
    });
    expect(response.status).toBe(404);
    expect(rig.gitHost.minted).toHaveLength(0);
  });

  it("a retried request with the same editId adopts the same PR instead of opening a second one", async () => {
    const editId = "edit_retry42";
    const first = await openEditorPullRequest(rig, user.cookie, project.id, {
      repositoryId: hostRepo.id,
      pipelinePath: ".factory/pipeline.yaml",
      yaml: VALID_YAML,
      editId,
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { prNumber: number; commitSha: string };

    // The second request re-writes the same branch: the Contents API answers
    // 422 (the fake mirrors GitHub), the create answers 422, and the open PR
    // is adopted — one PR for one edit.
    const second = await openEditorPullRequest(rig, user.cookie, project.id, {
      repositoryId: hostRepo.id,
      pipelinePath: ".factory/pipeline.yaml",
      yaml: VALID_YAML,
      editId,
    });
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as { prNumber: number; commitSha: string };
    expect(secondBody.prNumber).toBe(firstBody.prNumber);
    expect(rig.gitHost.contents.filter((w) => w.branch === `factory/editor/${editId}`)).toHaveLength(1);
    expect(rig.gitHost.pullRequests.filter((pr) => pr.head === `factory/editor/${editId}`)).toHaveLength(1);
    expect(rig.gitHost.revocations).toHaveLength(2); // one token per request, each revoked
  });

  it("revokes the minted token when the operation fails mid-flight — teardown runs on the error path too (AC3)", async () => {
    // The write lands, then the PR create fails with a transient 503 — the
    // mint happened, the operation failed, and the `finally` still revokes
    // the exact token that was minted, so no narrow token ever outlives its
    // operation, success or failure.
    rig.gitHost.failNextCreates = 1;
    const response = await openEditorPullRequest(rig, user.cookie, project.id, {
      repositoryId: hostRepo.id,
      pipelinePath: ".factory/pipeline.yaml",
      yaml: VALID_YAML,
      editId: "edit_midflight",
    });
    expect(response.status).toBe(500);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("internal_error");

    expect(rig.gitHost.minted).toHaveLength(1);
    expect(rig.gitHost.contents).toHaveLength(1);
    expect(rig.gitHost.pullRequests).toHaveLength(0);
    expect(rig.gitHost.revocations).toHaveLength(1);
    expect(rig.gitHost.revocations[0]!.token).toBe(rig.gitHost.minted[0]!.token);
  });
});
