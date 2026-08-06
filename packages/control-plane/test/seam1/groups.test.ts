/**
 * Acceptance criterion under test (issue #3): a Group can only contain
 * members of its own Project — rejected in the domain layer, not the UI.
 * Exercised here purely over HTTP, with no route or UI involved in the
 * rejection.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestRig, type TestRig } from "./setup.js";

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

async function createProject(rig: TestRig, ownerCookie: string, name: string): Promise<{ id: string }> {
  const response = await rig.fetchWithCsrf(`${rig.baseUrl}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: ownerCookie },
    body: JSON.stringify({ name }),
  });
  return response.json() as Promise<{ id: string }>;
}

async function addMember(rig: TestRig, adminCookie: string, projectId: string, principalId: string) {
  return rig.fetchWithCsrf(`${rig.baseUrl}/projects/${projectId}/members`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: adminCookie },
    body: JSON.stringify({ principalId, role: "member" }),
  });
}

describe("Group membership: same-Project invariant", () => {
  let rig: TestRig;
  let ownerCookie: string;

  beforeAll(async () => {
    rig = await startTestRig();
    ownerCookie = await rig.loginAsBreakGlass();
  });

  afterAll(async () => {
    await rig.stop();
  });

  it("creates a Group as a Project member", async () => {
    const project = await createProject(rig, ownerCookie, "group-home");
    await rig.fetchWithCsrf(`${rig.baseUrl}/projects/${project.id}/members/self`, {
      method: "POST",
      headers: { cookie: ownerCookie },
    });

    const response = await rig.fetchWithCsrf(`${rig.baseUrl}/projects/${project.id}/groups`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ name: "reviewers" }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ projectId: project.id, name: "reviewers" });
  });

  it("rejects adding a principal who is not a member of the Group's Project, with 400 and no UI in the loop", async () => {
    const project = await createProject(rig, ownerCookie, "group-home-2");
    await rig.fetchWithCsrf(`${rig.baseUrl}/projects/${project.id}/members/self`, {
      method: "POST",
      headers: { cookie: ownerCookie },
    });
    const groupResponse = await rig.fetchWithCsrf(`${rig.baseUrl}/projects/${project.id}/groups`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ name: "reviewers" }),
    });
    const group = (await groupResponse.json()) as { id: string };

    // A real user who exists, but was never added to this Project.
    const { principalId: outsiderPrincipalId } = await githubLogin(rig, 6001);

    const response = await rig.fetchWithCsrf(`${rig.baseUrl}/groups/${group.id}/members`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ principalId: outsiderPrincipalId }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.code).toBe("invalid_group_member");
    expect(body.message).toContain(project.id);
  });

  it("accepts adding a principal who is a member of the Group's Project", async () => {
    const project = await createProject(rig, ownerCookie, "group-home-3");
    await rig.fetchWithCsrf(`${rig.baseUrl}/projects/${project.id}/members/self`, {
      method: "POST",
      headers: { cookie: ownerCookie },
    });
    const { principalId: memberPrincipalId } = await githubLogin(rig, 6002);
    await addMember(rig, ownerCookie, project.id, memberPrincipalId);

    const groupResponse = await rig.fetchWithCsrf(`${rig.baseUrl}/projects/${project.id}/groups`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ name: "reviewers" }),
    });
    const group = (await groupResponse.json()) as { id: string };

    const response = await rig.fetchWithCsrf(`${rig.baseUrl}/groups/${group.id}/members`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ principalId: memberPrincipalId }),
    });
    expect(response.status).toBe(200);

    const { rows } = await rig.pool.query(
      "select 1 from group_members where group_id = $1 and principal_id = $2",
      [group.id, memberPrincipalId],
    );
    expect(rows).toHaveLength(1);
  });

  it("a non-member of the Project cannot create a Group in it", async () => {
    const project = await createProject(rig, ownerCookie, "group-home-4");
    const { cookie: outsiderCookie } = await githubLogin(rig, 6003);

    const response = await rig.fetchWithCsrf(`${rig.baseUrl}/projects/${project.id}/groups`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: outsiderCookie },
      body: JSON.stringify({ name: "reviewers" }),
    });
    expect(response.status).toBe(403);
  });
});
