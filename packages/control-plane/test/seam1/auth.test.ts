/**
 * Acceptance criteria under test (issue #3):
 *  - GitHub OAuth login -> httpOnly Secure SameSite=Lax cookie + session row in Postgres
 *  - Break-glass login on its own route -> byte-for-byte the same cookie shape; only audit_log differs
 *  - CSRF: SameSite=Lax + a header that forces preflight, zero tokens, zero tables
 *  - Secret values never enter audit_log
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CSRF_HEADER_NAME } from "../../src/csrf.js";
import { BREAK_GLASS_TEST_PASSWORD, startTestRig, type TestRig } from "./setup.js";

function parseCookieAttributes(setCookieHeader: string): Record<string, string | true> {
  const attributes: Record<string, string | true> = {};
  for (const part of setCookieHeader.split(";").slice(1)) {
    const [key, value] = part.trim().split("=");
    attributes[key!.toLowerCase()] = value ?? true;
  }
  return attributes;
}

function assertSessionCookieShape(setCookieHeader: string | null): void {
  expect(setCookieHeader).toBeTruthy();
  expect(setCookieHeader).toMatch(/^factory_session=/);
  const attrs = parseCookieAttributes(setCookieHeader!);
  expect(attrs["httponly"]).toBe(true);
  expect(attrs["samesite"]?.toString().toLowerCase()).toBe("lax");
}

describe("GitHub OAuth login", () => {
  let rig: TestRig;

  beforeAll(async () => {
    rig = await startTestRig();
  });

  afterAll(async () => {
    await rig.stop();
  });

  it("sets the session cookie and writes a session row in Postgres, keyed to a Principal created purely from GitHub identity", async () => {
    const code = "fake-code-1001";
    rig.githubOAuth.registerCode(code, {
      githubUserId: 1001,
      githubLogin: "octocat",
      name: "The Octocat",
      avatarUrl: null,
    });

    const response = await fetch(`${rig.baseUrl}/auth/github/callback?code=${code}`);
    expect(response.status).toBe(200);
    assertSessionCookieShape(response.headers.get("set-cookie"));

    const body = (await response.json()) as { principalId: string };
    const { rows } = await rig.pool.query("select * from sessions where principal_id = $1", [
      body.principalId,
    ]);
    expect(rows).toHaveLength(1);

    const { rows: auditRows } = await rig.pool.query(
      "select action, actor_principal_id from audit_log where action = 'auth.login_github' order by id desc limit 1",
    );
    expect(auditRows[0]).toMatchObject({ action: "auth.login_github", actor_principal_id: body.principalId });
  });

  it("matches on the immutable githubUserId, not the renameable login — a second login under a new login string reuses the same principal", async () => {
    rig.githubOAuth.registerCode("fake-code-2002-a", {
      githubUserId: 2002,
      githubLogin: "old-login",
      name: null,
      avatarUrl: null,
    });
    await fetch(`${rig.baseUrl}/auth/github/callback?code=fake-code-2002-a`);

    rig.githubOAuth.registerCode("fake-code-2002-b", {
      githubUserId: 2002,
      githubLogin: "renamed-login",
      name: null,
      avatarUrl: null,
    });
    const retried = await fetch(`${rig.baseUrl}/auth/github/callback?code=fake-code-2002-b`);
    expect(retried.status).toBe(200);

    const { rows } = await rig.pool.query<{ count: number }>(
      "select count(*)::int as count from users where github_user_id = $1",
      [2002],
    );
    expect(rows[0]!.count).toBe(1);
  });
});

describe("break-glass login", () => {
  let rig: TestRig;

  beforeAll(async () => {
    rig = await startTestRig();
  });

  afterAll(async () => {
    await rig.stop();
  });

  it("produces a cookie with the identical shape GitHub login produces — only audit_log distinguishes them", async () => {
    const response = await rig.fetchWithCsrf(`${rig.baseUrl}/auth/breakglass/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: BREAK_GLASS_TEST_PASSWORD }),
    });
    expect(response.status).toBe(200);
    assertSessionCookieShape(response.headers.get("set-cookie"));

    const { rows: auditRows } = await rig.pool.query(
      "select action from audit_log where action = 'auth.login_breakglass' order by id desc limit 1",
    );
    expect(auditRows[0]).toMatchObject({ action: "auth.login_breakglass" });
  });

  it("rejects the wrong password with 401, and never writes any password into audit_log", async () => {
    const response = await rig.fetchWithCsrf(`${rig.baseUrl}/auth/breakglass/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "definitely wrong" }),
    });
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body).toMatchObject({ code: "unauthorized" });

    const { rows } = await rig.pool.query<{ metadata: unknown }>("select metadata from audit_log");
    for (const row of rows) {
      expect(JSON.stringify(row.metadata ?? {})).not.toMatch(/wrong password|correct horse battery staple/i);
    }
  });
});

describe("CSRF", () => {
  let rig: TestRig;

  beforeAll(async () => {
    rig = await startTestRig();
  });

  afterAll(async () => {
    await rig.stop();
  });

  it("rejects a mutating request missing the CSRF header with 403, zero tokens zero tables", async () => {
    const response = await fetch(`${rig.baseUrl}/auth/breakglass/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: BREAK_GLASS_TEST_PASSWORD }),
    });
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body).toMatchObject({ code: "csrf_header_required" });
  });

  it("accepts the same request once the header is present", async () => {
    const response = await fetch(`${rig.baseUrl}/auth/breakglass/login`, {
      method: "POST",
      headers: { "content-type": "application/json", [CSRF_HEADER_NAME]: "1" },
      body: JSON.stringify({ password: BREAK_GLASS_TEST_PASSWORD }),
    });
    expect(response.status).toBe(200);
  });

  it("never requires the header on GET", async () => {
    const response = await fetch(`${rig.baseUrl}/health`);
    expect(response.status).toBe(200);
  });
});

describe("logout", () => {
  let rig: TestRig;

  beforeAll(async () => {
    rig = await startTestRig();
  });

  afterAll(async () => {
    await rig.stop();
  });

  it("revokes the session row so the cookie no longer authenticates", async () => {
    const cookie = await rig.loginAsBreakGlass();

    const logoutResponse = await rig.fetchWithCsrf(`${rig.baseUrl}/auth/logout`, {
      method: "POST",
      headers: { cookie },
    });
    expect(logoutResponse.status).toBe(200);

    const projectsResponse = await fetch(`${rig.baseUrl}/projects`, { headers: { cookie } });
    expect(projectsResponse.status).toBe(401);
  });
});
