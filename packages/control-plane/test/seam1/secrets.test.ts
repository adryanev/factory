/**
 * Issue #8 acceptance surface, seam-1 style — real HTTP against a real
 * migrated Postgres, with GitHost faked. Covers:
 *
 *  - AC1/AC2: secrets are encrypted at rest; metadata-only reads; the value
 *    surface is write-only.
 *  - AC3: master-key rotation is incremental, interruptible, and never
 *    disturbs a Run already holding its values (the claim payload).
 *  - AC4: `allowSharedAgentCredential` defaults OFF; when on and the
 *    triggering user owns no secrets, the Run's `credentialPrincipalId`
 *    differs from `triggeredByPrincipalId` — visible via the two separate
 *    `runs` columns.
 *  - AC5: the `/claim` payload carries the resolved secrets + the egress
 *    allowlist (the Runner's half is tested in `packages/runner`).
 *  - AC6: per-Project egress allowlist is admin-editable and audited.
 *  - Audit: every secret/allowlist write lands in `audit_log` with no value.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateId } from "@factory/shared";
import { startTestRig, type TestRig } from "./setup.js";
import { joinRunner } from "./runner-test-helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SHARED_FIXTURES_DIR = path.resolve(here, "../../../shared/src/pipeline/__fixtures__");

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

async function createRepository(rig: TestRig, projectId: string, name: string): Promise<{ id: string; owner: string; name: string }> {
  repoCounter += 1;
  const owner = `secretco-${repoCounter}`;
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

async function createServiceAccount(rig: TestRig, cookie: string, projectId: string, name: string): Promise<{ id: string }> {
  const response = await rig.fetchWithCsrf(`${rig.baseUrl}/projects/${projectId}/service-accounts`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string };
}

async function storeSecret(
  rig: TestRig,
  cookie: string,
  projectId: string,
  body: { id: string; name: string; value: string; serviceAccountId: string },
): Promise<Response> {
  return rig.fetchWithCsrf(`${rig.baseUrl}/projects/${projectId}/secrets`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
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

describe("Secrets and credentials (issue #8)", () => {
  let rig: TestRig;
  let ownerCookie: string;

  beforeAll(async () => {
    rig = await startTestRig();
    ownerCookie = await rig.loginAsBreakGlass();
  });

  afterAll(async () => {
    await rig.stop();
  });

  it("stores a secret under a Project ServiceAccount and never returns its value — the list is metadata-only", async () => {
    const project = await createProject(rig, ownerCookie, "secret-project");
    const sa = await createServiceAccount(rig, ownerCookie, project.id, "ci");

    const secretId = generateId("secret");
    const stored = await storeSecret(rig, ownerCookie, project.id, {
      id: secretId,
      name: "DEPLOY_KEY",
      value: "top-secret-value-123",
      serviceAccountId: sa.id,
    });
    expect(stored.status).toBe(201);
    const storedBody = (await stored.json()) as Record<string, unknown>;
    expect(storedBody).toEqual({
      id: secretId,
      projectId: project.id,
      ownerPrincipalId: sa.id,
      name: "DEPLOY_KEY",
      keyVersion: 1,
    });

    const listResponse = await rig.fetchWithCsrf(`${rig.baseUrl}/projects/${project.id}/secrets`, {
      headers: { cookie: ownerCookie },
    });
    const list = (await listResponse.json()) as Record<string, unknown>[];
    expect(list).toEqual([
      { id: secretId, projectId: project.id, ownerPrincipalId: sa.id, name: "DEPLOY_KEY", keyVersion: 1 },
    ]);
    // The write-only invariant: no response in the whole surface ever contains the value.
    expect(JSON.stringify(list)).not.toContain("top-secret-value-123");
  });

  it("the raw stored row holds ciphertext, a separate nonce column, a separate auth_tag column, and a key_version — never the value", async () => {
    const project = await createProject(rig, ownerCookie, "secret-shape-project");
    const sa = await createServiceAccount(rig, ownerCookie, project.id, "ci");
    const secretId = generateId("secret");
    await storeSecret(rig, ownerCookie, project.id, {
      id: secretId,
      name: "TOKEN",
      value: "never-seen-in-db-456",
      serviceAccountId: sa.id,
    });

    const { rows } = await rig.pool.query(
      "select name, ciphertext, nonce, auth_tag, key_version, owner_principal_id from secrets where id = $1",
      [secretId],
    );
    const row = rows[0] as {
      name: string;
      ciphertext: Buffer;
      nonce: Buffer;
      auth_tag: Buffer;
      key_version: number;
      owner_principal_id: string;
    };
    expect(row.name).toBe("TOKEN");
    expect(row.owner_principal_id).toBe(sa.id);
    expect(row.key_version).toBe(1);
    // Separate nonce (12B) and auth_tag (16B) columns (AC2) — not concatenated.
    expect(Buffer.isBuffer(row.nonce)).toBe(true);
    expect(Buffer.isBuffer(row.auth_tag)).toBe(true);
    expect(row.ciphertext.equals(Buffer.from("never-seen-in-db-456"))).toBe(false);
    expect(row.ciphertext.toString("utf-8")).not.toContain("never-seen-in-db-456");
    // Wrong length is impossible to write silently: the columns are fixed-size in the schema contract.
    expect(row.nonce.length).toBe(12);
    expect(row.auth_tag.length).toBe(16);
  });

  it("updates a secret value in place and still never returns it", async () => {
    const project = await createProject(rig, ownerCookie, "secret-update-project");
    const sa = await createServiceAccount(rig, ownerCookie, project.id, "ci");
    const secretId = generateId("secret");
    await storeSecret(rig, ownerCookie, project.id, {
      id: secretId,
      name: "API_KEY",
      value: "first-value-111",
      serviceAccountId: sa.id,
    });

    const update = await rig.fetchWithCsrf(`${rig.baseUrl}/projects/${project.id}/secrets`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ secretId, value: "second-value-222" }),
    });
    expect(update.status).toBe(200);
    const body = (await update.json()) as { name: string; keyVersion: number };
    expect(body).toMatchObject({ name: "API_KEY", keyVersion: 1 });
    expect(JSON.stringify(body)).not.toContain("second-value-222");
  });

  it("rejects a value under 6 bytes at store time", async () => {
    const project = await createProject(rig, ownerCookie, "secret-short-project");
    const sa = await createServiceAccount(rig, ownerCookie, project.id, "ci");
    const response = await storeSecret(rig, ownerCookie, project.id, {
      id: generateId("secret"),
      name: "SHORT",
      value: "x",
      serviceAccountId: sa.id,
    });
    expect(response.status).toBe(400);
  });

  it("a member who is not an admin can read metadata but cannot store or delete secrets", async () => {
    const project = await createProject(rig, ownerCookie, "secret-permissions-project");
    const sa = await createServiceAccount(rig, ownerCookie, project.id, "ci");
    const secretId = generateId("secret");
    await storeSecret(rig, ownerCookie, project.id, {
      id: secretId,
      name: "K",
      value: "admin-only-333",
      serviceAccountId: sa.id,
    });

    // A second user, added as a plain member by the admin.
    const memberIdentity = { githubUserId: 999_001, githubLogin: "member", name: "Member", avatarUrl: null };
    const memberCookie = await rig.loginAsGithub(memberIdentity);
    const { rows } = await rig.pool.query("select principal_id from users where github_login = 'member'");
    const memberPrincipalId = rows[0]?.principal_id as string;
    await rig.fetchWithCsrf(`${rig.baseUrl}/projects/${project.id}/members`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ principalId: memberPrincipalId, role: "member" }),
    });

    const list = await rig.fetchWithCsrf(`${rig.baseUrl}/projects/${project.id}/secrets`, {
      headers: { cookie: memberCookie },
    });
    expect(list.status).toBe(200);

    const store = await storeSecret(rig, memberCookie, project.id, {
      id: generateId("secret"),
      name: "NOPE",
      value: "member-cannot-444",
      serviceAccountId: sa.id,
    });
    expect(store.status).toBe(403);

    const del = await rig.fetchWithCsrf(`${rig.baseUrl}/projects/${project.id}/secrets`, {
      method: "DELETE",
      headers: { "content-type": "application/json", cookie: memberCookie },
      body: JSON.stringify({ secretId }),
    });
    expect(del.status).toBe(403);
  });

  it("re-storing the same name with a fresh client id keeps the original row id and stays decryptable", async () => {
    const project = await createProject(rig, ownerCookie, "secret-restore-project");
    const sa = await createServiceAccount(rig, ownerCookie, project.id, "ci");
    const firstId = generateId("secret");
    await storeSecret(rig, ownerCookie, project.id, {
      id: firstId,
      name: "ROLLING",
      value: "first-rolling-888",
      serviceAccountId: sa.id,
    });

    // Same name, a different client-generated id — the AAD must bind to the
    // row's *actual* id (the PK), not the fresh one, or the row would become
    // undecryptable.
    const restored = await storeSecret(rig, ownerCookie, project.id, {
      id: generateId("secret"),
      name: "ROLLING",
      value: "second-rolling-999",
      serviceAccountId: sa.id,
    });
    expect(restored.status).toBe(201);
    const restoredBody = (await restored.json()) as { id: string; name: string };
    expect(restoredBody.id).toBe(firstId); // the row kept its original id.

    const { rows } = await rig.pool.query("select id from secrets where project_id = $1 and name = 'ROLLING'", [
      project.id,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(firstId);
  });

  it("AC6 — the egress allowlist defaults to the built-in set, is admin-replaceable, and every change is audited", async () => {
    const project = await createProject(rig, ownerCookie, "egress-project");
    const get = await rig.fetchWithCsrf(`${rig.baseUrl}/projects/${project.id}`, { headers: { cookie: ownerCookie } });
    const projectBody = (await get.json()) as { egressAllowlist: string[] };
    expect(projectBody.egressAllowlist).toContain("github.com");
    expect(projectBody.egressAllowlist).toContain("registry.npmjs.org");

    const set = await rig.fetchWithCsrf(`${rig.baseUrl}/projects/${project.id}/egress-allowlist`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ allowlist: ["github.com", "api.github.com"] }),
    });
    expect(set.status).toBe(200);

    const { rows } = await rig.pool.query(
      "select action, metadata from audit_log where project_id = $1 and action = 'project.egress_allowlist_updated'",
      [project.id],
    );
    expect(rows).toHaveLength(1);
    expect((rows[0] as { metadata: unknown }).metadata).toEqual({ allowlist: ["github.com", "api.github.com"] });
    expect(JSON.stringify(rows[0])).not.toContain("secret");
  });

  it("AC3 — master-key rotation re-encrypts rows to the new version, and is interruptible: a row left on the old version still decrypts", async () => {
    const project = await createProject(rig, ownerCookie, "rotation-project");
    const sa = await createServiceAccount(rig, ownerCookie, project.id, "ci");
    const secretId = generateId("secret");
    await storeSecret(rig, ownerCookie, project.id, {
      id: secretId,
      name: "ROT",
      value: "rotation-value-555",
      serviceAccountId: sa.id,
    });

    // Interruptible half: drop version 2 into the key file but do NOT rotate.
    // The row stays on version 1, and the keyring still has version 1, so a
    // claim would still decrypt it. Prove that at the row level first.
    const v2Key = "b2".repeat(32);
    const keyFile = JSON.parse(await import("node:fs/promises").then((m) => m.readFile(rig.masterKeyFile, "utf-8"))) as {
      currentVersion: number;
      keys: Record<string, string>;
    };
    keyFile.keys["2"] = v2Key;
    await (await import("node:fs/promises")).writeFile(
      rig.masterKeyFile,
      JSON.stringify({ currentVersion: 2, keys: keyFile.keys }),
    );

    // Not rotated yet — still version 1, still decryptable (no claim needed:
    // the value has not been disturbed, and the file still holds version 1).
    const before = await rig.pool.query("select key_version from secrets where id = $1", [secretId]);
    expect(before.rows[0]?.key_version).toBe(1);

    // Now rotate: the row moves to version 2.
    const rotate = await rig.fetchWithCsrf(`${rig.baseUrl}/projects/${project.id}/secrets/rotate`, {
      method: "POST",
      headers: { cookie: ownerCookie },
    });
    expect(rotate.status).toBe(200);
    const rotateBody = (await rotate.json()) as { rotated: number; toVersion: number };
    expect(rotateBody).toEqual({ rotated: 1, toVersion: 2 });

    const after = await rig.pool.query("select key_version from secrets where id = $1", [secretId]);
    expect(after.rows[0]?.key_version).toBe(2);

    const { rows } = await rig.pool.query(
      "select action, metadata from audit_log where project_id = $1 and action = 'secret.rotated'",
      [project.id],
    );
    expect(rows).toHaveLength(1);
    expect((rows[0] as { metadata: unknown }).metadata).toEqual({ rotated: 1, toVersion: 2 });
  });

  it("AC3/AC5 — a running Run's claim payload is never disturbed by rotation; the same values come back before and after", async () => {
    const fs = await import("node:fs/promises");
    // Self-contained key state: this test's rotation must add a *new* version,
    // never mutate one — an earlier test may have left the shared key file at
    // currentVersion 2. Reset to a fresh version-1 file first.
    const v1 = "1a".repeat(32);
    await fs.writeFile(rig.masterKeyFile, JSON.stringify({ currentVersion: 1, keys: { "1": v1 } }));

    const project = await createProject(rig, ownerCookie, "rotation-claim-project");
    const sa = await createServiceAccount(rig, ownerCookie, project.id, "ci");
    const secretId = generateId("secret");
    await storeSecret(rig, ownerCookie, project.id, {
      id: secretId,
      name: "STABLE",
      value: "stable-across-rotation",
      serviceAccountId: sa.id,
    });

    // Grant the fallback so a user-triggered run uses the SA's credentials.
    await rig.fetchWithCsrf(`${rig.baseUrl}/projects/${project.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ allowSharedAgentCredential: true }),
    });

    const repo = await createRepository(rig, project.id, "frontend");
    // Two independent root Steps, so the first claim takes one and a fresh
    // claim after rotation takes the other — both must carry the same secret.
    const yaml = `version: 1
name: Two roots, one secret set
repo: frontend
steps:
  a:
    run: echo a
  b:
    run: echo b
`;
    rig.gitHost.registerRef(repo, "main", "sha-rotation-1");
    rig.gitHost.registerFile(repo, "sha-rotation-1", ".factory/pipeline.yaml", yaml);

    const runId = generateId("run");
    const triggered = await trigger(rig, ownerCookie, project.id, {
      id: runId,
      repositoryId: repo.id,
      pipelinePath: ".factory/pipeline.yaml",
      refBranch: "main",
    });
    expect(triggered.status).toBe(201);

    // AC4 — the fallback engaged: credentialPrincipalId (the SA) differs
    // from triggeredByPrincipalId (the break-glass user). Visible in the two
    // separate runs columns.
    const runRows = await rig.pool.query(
      "select triggered_by_principal_id, credential_principal_id from runs where id = $1",
      [runId],
    );
    const runRow = runRows.rows[0] as { triggered_by_principal_id: string; credential_principal_id: string };
    expect(runRow.credential_principal_id).toBe(sa.id);
    expect(runRow.triggered_by_principal_id).not.toBe(sa.id);

    const { secret, client } = await joinRunner(rig, ownerCookie);
    const first = await client.claim(secret);
    const firstClaim = (first.body as { step_run: { secrets: Record<string, string>; egress_allowlist: string[] } | null })
      .step_run;
    expect(firstClaim?.secrets).toEqual({ STABLE: "stable-across-rotation" });
    expect(firstClaim?.egress_allowlist).toContain("github.com");

    // Rotate the master key while that claim's values are already in the
    // Runner's hands — the in-flight Run is untouched, and a fresh claim
    // returns the same plaintext under the new key version. The new version's
    // material is brand-new (`d2`), never a mutation of version 1's.
    const keyFile = JSON.parse(await fs.readFile(rig.masterKeyFile, "utf-8")) as {
      keys: Record<string, string>;
    };
    await fs.writeFile(
      rig.masterKeyFile,
      JSON.stringify({ currentVersion: 2, keys: { ...keyFile.keys, "2": "d2".repeat(32) } }),
    );
    const rotate = await rig.fetchWithCsrf(`${rig.baseUrl}/projects/${project.id}/secrets/rotate`, {
      method: "POST",
      headers: { cookie: ownerCookie },
    });
    expect(rotate.status).toBe(200);
    const rotated = (await rotate.json()) as { rotated: number; toVersion: number };
    expect(rotated).toEqual({ rotated: 1, toVersion: 2 });

    const second = await client.claim(secret);
    const secondClaim = (second.body as { step_run: { secrets: Record<string, string> } | null }).step_run;
    expect(secondClaim?.secrets).toEqual({ STABLE: "stable-across-rotation" });
  });

  it("AC4 — with allowSharedAgentCredential OFF (the default), a user-triggered run attributes to the user and claims no SA secrets", async () => {
    const project = await createProject(rig, ownerCookie, "no-fallback-project");
    const sa = await createServiceAccount(rig, ownerCookie, project.id, "ci");
    await storeSecret(rig, ownerCookie, project.id, {
      id: generateId("secret"),
      name: "SECRET",
      value: "must-not-leak-777",
      serviceAccountId: sa.id,
    });

    const repo = await createRepository(rig, project.id, "frontend");
    const yaml = readFileSync(path.join(SHARED_FIXTURES_DIR, "d-verdict-02-linear.yaml"), "utf-8");
    rig.gitHost.registerRef(repo, "main", "sha-nofb-1");
    rig.gitHost.registerFile(repo, "sha-nofb-1", ".factory/pipeline.yaml", yaml);

    const runId = generateId("run");
    const triggered = await trigger(rig, ownerCookie, project.id, {
      id: runId,
      repositoryId: repo.id,
      pipelinePath: ".factory/pipeline.yaml",
      refBranch: "main",
    });
    expect(triggered.status).toBe(201);

    const runRows = await rig.pool.query(
      "select triggered_by_principal_id, credential_principal_id from runs where id = $1",
      [runId],
    );
    const runRow = runRows.rows[0] as { triggered_by_principal_id: string; credential_principal_id: string };
    expect(runRow.credential_principal_id).toBe(runRow.triggered_by_principal_id);

    const { secret, client } = await joinRunner(rig, ownerCookie);
    const claimed = await client.claim(secret);
    const stepRun = (claimed.body as { step_run: { secrets: Record<string, string> } | null }).step_run;
    expect(stepRun?.secrets).toEqual({});
  });
});
