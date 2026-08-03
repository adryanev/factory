/**
 * Acceptance criteria under test (issue #3):
 *  - 401 not logged in, 403 logged in but not permitted (body names the
 *    Project and the reason), 404 genuinely absent
 *  - An org owner denied a Project sees the self-add offer, and self-adding
 *    is recorded in audit_log
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestRig, type TestRig } from "./setup.js";

/** Logs a fresh GitHub identity in and returns both its session cookie and its principal id (read back from Postgres — there is no "whoami" endpoint in this issue's surface). */
async function githubLogin(rig: TestRig, githubUserId: number): Promise<{ cookie: string; principalId: string }> {
  const cookie = await rig.loginAsGithub({
    githubUserId,
    githubLogin: `user-${githubUserId}`,
    name: null,
    avatarUrl: null,
  });
  const { rows } = await rig.pool.query<{ principal_id: string }>(
    "select principal_id from users where github_user_id = $1",
    [githubUserId],
  );
  return { cookie, principalId: rows[0]!.principal_id };
}

async function createProjectAsOwner(rig: TestRig, ownerCookie: string, name: string): Promise<{ id: string }> {
  const response = await rig.fetchWithCsrf(`${rig.baseUrl}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: ownerCookie },
    body: JSON.stringify({ name }),
  });
  expect(response.status).toBe(201);
  return response.json() as Promise<{ id: string }>;
}

async function addMember(
  rig: TestRig,
  adminCookie: string,
  projectId: string,
  targetPrincipalId: string,
  role: "admin" | "member",
): Promise<Response> {
  return rig.fetchWithCsrf(`${rig.baseUrl}/projects/${projectId}/members`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: adminCookie },
    body: JSON.stringify({ principalId: targetPrincipalId, role }),
  });
}

/** The org owner escape hatch, used here purely as setup: an owner who just created a Project is not automatically a member of it (this issue's core rule) — tests that need the owner to act as admin self-add first, exactly like a real operator would. */
async function selfAddOwner(rig: TestRig, ownerCookie: string, projectId: string): Promise<void> {
  const response = await rig.fetchWithCsrf(`${rig.baseUrl}/projects/${projectId}/members/self`, {
    method: "POST",
    headers: { cookie: ownerCookie },
  });
  if (response.status !== 200) {
    throw new Error(`self-add setup failed: ${response.status} ${await response.text()}`);
  }
}

describe("Project access: 401/403/404", () => {
  let rig: TestRig;
  let ownerCookie: string;

  beforeAll(async () => {
    rig = await startTestRig();
    ownerCookie = await rig.loginAsBreakGlass(); // bootstrapped as org owner
  });

  afterAll(async () => {
    await rig.stop();
  });

  it("401s an anonymous request", async () => {
    const response = await fetch(`${rig.baseUrl}/projects`);
    expect(response.status).toBe(401);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ code: "unauthorized" });
  });

  it("404s a Project id that was never created", async () => {
    const response = await fetch(`${rig.baseUrl}/projects/project_00000000000000000000000000`, {
      headers: { cookie: ownerCookie },
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ code: "not_found" });
  });

  it("403s a logged-in non-member on a Project that does exist, naming the Project and the reason in the body", async () => {
    const project = await createProjectAsOwner(rig, ownerCookie, "quietly-owned");
    const { cookie: outsiderCookie } = await githubLogin(rig, 5001);

    const response = await fetch(`${rig.baseUrl}/projects/${project.id}`, {
      headers: { cookie: outsiderCookie },
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.code).toBe("forbidden_not_project_member");
    expect(body.message).toContain(project.id);
  });

  it("member sees the Project once added", async () => {
    const project = await createProjectAsOwner(rig, ownerCookie, "with-a-member");
    await selfAddOwner(rig, ownerCookie, project.id);
    const { cookie: memberCookie, principalId } = await githubLogin(rig, 5002);

    const addResponse = await addMember(rig, ownerCookie, project.id, principalId, "member");
    expect(addResponse.status).toBe(200);

    const getResponse = await fetch(`${rig.baseUrl}/projects/${project.id}`, {
      headers: { cookie: memberCookie },
    });
    expect(getResponse.status).toBe(200);
  });
});

describe("org owner escape hatch", () => {
  let rig: TestRig;
  let ownerCookie: string;

  beforeAll(async () => {
    rig = await startTestRig();
    ownerCookie = await rig.loginAsBreakGlass();
  });

  afterAll(async () => {
    await rig.stop();
  });

  it("403 body for an org owner names the self-add path, distinct from a plain member's 403", async () => {
    const project = await createProjectAsOwner(rig, ownerCookie, "owner-not-yet-a-member");

    const response = await fetch(`${rig.baseUrl}/projects/${project.id}`, {
      headers: { cookie: ownerCookie },
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.code).toBe("forbidden_not_project_member_org_owner");
    expect(body.message).toContain("members/self");
  });

  it("self-add succeeds, is audited, and grants access on the next read", async () => {
    const project = await createProjectAsOwner(rig, ownerCookie, "owner-self-adds");

    const selfAddResponse = await rig.fetchWithCsrf(`${rig.baseUrl}/projects/${project.id}/members/self`, {
      method: "POST",
      headers: { cookie: ownerCookie },
    });
    expect(selfAddResponse.status).toBe(200);

    const getResponse = await fetch(`${rig.baseUrl}/projects/${project.id}`, {
      headers: { cookie: ownerCookie },
    });
    expect(getResponse.status).toBe(200);

    const { rows } = await rig.pool.query(
      "select metadata from audit_log where action = 'project.member_added' and project_id = $1 order by id desc limit 1",
      [project.id],
    );
    expect(rows[0]!.metadata).toMatchObject({ role: "admin", selfAddedByOrgOwner: true });
  });

  it("a non-owner cannot use the self-add path", async () => {
    const project = await createProjectAsOwner(rig, ownerCookie, "not-owner-self-add");
    const { cookie: nonOwnerCookie } = await githubLogin(rig, 5003);

    const response = await rig.fetchWithCsrf(`${rig.baseUrl}/projects/${project.id}/members/self`, {
      method: "POST",
      headers: { cookie: nonOwnerCookie },
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.code).toBe("forbidden_not_org_owner");
  });
});

describe("Project creation and membership management", () => {
  let rig: TestRig;
  let ownerCookie: string;

  beforeAll(async () => {
    rig = await startTestRig();
    ownerCookie = await rig.loginAsBreakGlass();
  });

  afterAll(async () => {
    await rig.stop();
  });

  it("only an org owner may create a Project", async () => {
    const { cookie: nonOwnerCookie } = await githubLogin(rig, 5004);
    const response = await rig.fetchWithCsrf(`${rig.baseUrl}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: nonOwnerCookie },
      body: JSON.stringify({ name: "nope" }),
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.code).toBe("forbidden_not_org_owner");
  });

  it("only a Project admin may add a member", async () => {
    const project = await createProjectAsOwner(rig, ownerCookie, "admin-gated");
    await selfAddOwner(rig, ownerCookie, project.id);
    const { cookie: memberCookie, principalId: memberPrincipalId } = await githubLogin(rig, 5005);
    await addMember(rig, ownerCookie, project.id, memberPrincipalId, "member");

    const { principalId: targetPrincipalId } = await githubLogin(rig, 5006);

    const response = await addMember(rig, memberCookie, project.id, targetPrincipalId, "member");
    expect(response.status).toBe(403);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.code).toBe("forbidden_not_project_admin");
  });
});

describe("CSRF header on mutating Project routes", () => {
  let rig: TestRig;

  beforeAll(async () => {
    rig = await startTestRig();
  });

  afterAll(async () => {
    await rig.stop();
  });

  it("rejects POST /projects without the CSRF header even when logged in", async () => {
    const cookie = await rig.loginAsBreakGlass();
    const response = await fetch(`${rig.baseUrl}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "no-csrf-header" }),
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.code).toBe("csrf_header_required");
  });
});
