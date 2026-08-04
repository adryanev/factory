/**
 * The third seam this issue grows into its full shape: the narrow read-only
 * `GitHost` issue #4 shipped becomes, here, the interface that answers "how
 * does a turn get at the git remote as a bus" (spec: "Credential, secret,
 * dan akses repo" + "Git sebagai bus antar step"). One real implementation
 * (GitHub), one fake for test (`test/seam1/fake-git-host.ts`) — seam-1
 * tests never dial out to github.com.
 *
 * The Runner does the actual fetch/commit/push with the host-side `git`
 * CLI, using installation tokens the control plane mints. This interface is
 * the control plane's half of that transport:
 *
 *  - `mintInstallationToken` — the control plane mints, **twice per turn**,
 *    scoped to exactly the Repository the StepRun touches, `contents: write`
 *    and nothing else, 1-hour TTL (GitHub's fixed value). Called by `/claim`
 *    and carried to the Runner in the claim payload (spec: "token repo
 *    per-StepRun ikut di muatan /claim"). Teardown revocation ("dihapus saat
 *    teardown, jangan tunggu expiry") is the Runner's own job: it holds the
 *    tokens and `DELETE /installation/token` authenticates with the token
 *    itself, so the Runner's host-side teardown revokes them without ever
 *    needing the App credential (see `packages/runner`).
 *  - `push` — API-based push (Git Data API), consumed by seam-3 (issue 11's
 *    PR opening and the Pipeline editor), not by the Runner's own git CLI
 *    transport. Present here so the interface and its fake cover the whole
 *    seam now; 422 ("ref already exists") is treated as success, exactly the
 *    seam-3 acceptance criterion.
 *
 * The real implementation below mints the app JWT itself (RS256 over the
 * GitHub App private key, `node:crypto` — no dependency). `resolveRef` /
 * `readFile` stay unauthenticated `fetch`, as issue #4 left them, since
 * trigger-time reads are public-repo-only today; `repositories.githubAppInstallationId`
 * (schema, issue #4) is what wires a Repository to the App installation the
 * minting below hits.
 */
import { createSign } from "node:crypto";

export interface RepoRef {
  owner: string;
  name: string;
}

export class RefNotFoundError extends Error {
  constructor(repo: RepoRef, ref: string) {
    super(`ref '${ref}' not found in ${repo.owner}/${repo.name}`);
    this.name = "RefNotFoundError";
  }
}

/** A GitHub App installation access token, minted for exactly one turn. */
export interface InstallationToken {
  /** The raw bearer credential the Runner passes to `git fetch` / `git push`. */
  token: string;
  /** GitHub's fixed 1-hour lifetime — installation tokens cannot be refreshed. */
  expiresAt: Date;
  /** GitHub's numeric repository ids the token is narrowed to — the sandbox cannot touch any repo outside this list. */
  repositoryIds: number[];
  /** The permission subset carried — `contents: write` and nothing else. */
  permissions: Record<string, string>;
}

export interface GitHost {
  /** Resolves a branch (or other ref) to the commit SHA it currently points at. Throws {@link RefNotFoundError} if the ref does not exist. */
  resolveRef(repo: RepoRef, ref: string): Promise<string>;
  /** Reads a file's raw content at an exact commit SHA. Returns `null` if no file exists at that path — a missing file is an expected outcome, not an error. */
  readFile(repo: RepoRef, sha: string, path: string): Promise<string | null>;
  /** Mints a 1-hour installation access token scoped to `repo` (`repository_ids` = this repo alone, `permissions` = `contents: write`). `installationId` is the GitHub App's numeric installation id for the repository. */
  mintInstallationToken(repo: RepoRef, installationId: number): Promise<InstallationToken>;
  /** Points the remote `branch` at `sha` through the Git Data API, authenticated with `token`. 422 (ref already exists) is treated as success — idempotent by shape. */
  push(repo: RepoRef, branch: string, sha: string, token: string): Promise<void>;
}

/** Credentials that let the control plane act as the GitHub App itself (minting installation tokens). `privateKey` is the app's PEM; never logged, never leaves the process. */
export interface GithubAppConfig {
  appId: number;
  privateKey: string;
}

interface GithubCommitResponse {
  sha: string;
}

interface GithubContentsResponse {
  type: string;
  encoding: string;
  content: string;
}

interface GithubRepoResponse {
  id: number;
}

interface GithubTokenResponse {
  token: string;
  expires_at: string;
}

const GITHUB_ACCEPT = { accept: "application/vnd.github+json" } as const;

/** Signs a GitHub App JWT (header `alg: RS256`, payload `iss: appId`, ≤10 min lifetime) — the credential that lets the app mint installation tokens. */
export function signGithubAppJwt(appId: number, privateKeyPem: string, now: Date): string {
  const iat = Math.floor(now.getTime() / 1000);
  const header = { alg: "RS256" as const, typ: "JWT" as const };
  const payload = { iat, exp: iat + 600, iss: appId };
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${encode(header)}.${encode(payload)}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(privateKeyPem, "base64url");
  return `${signingInput}.${signature}`;
}

async function numericRepoId(repo: RepoRef): Promise<number> {
  const response = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.name}`, {
    headers: GITHUB_ACCEPT,
  });
  if (!response.ok) {
    throw new Error(`github repo lookup failed: ${response.status}`);
  }
  const body = (await response.json()) as GithubRepoResponse;
  return body.id;
}

/**
 * Real implementation over the GitHub REST API. Takes the GitHub App
 * credentials so it can mint installation tokens; when they are absent
 * (`config` omitted) the read half still works for public repositories and
 * any mint/push throws a clear "not configured" error instead of reaching
 * github.com.
 */
export function createGithubHost(config?: GithubAppConfig): GitHost {
  return {
    async resolveRef(repo, ref) {
      const response = await fetch(
        `https://api.github.com/repos/${repo.owner}/${repo.name}/commits/${encodeURIComponent(ref)}`,
        { headers: GITHUB_ACCEPT },
      );
      if (response.status === 404) {
        throw new RefNotFoundError(repo, ref);
      }
      if (!response.ok) {
        throw new Error(`github commit lookup failed: ${response.status}`);
      }
      const body = (await response.json()) as GithubCommitResponse;
      return body.sha;
    },

    async readFile(repo, sha, path) {
      const response = await fetch(
        `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${path}?ref=${encodeURIComponent(sha)}`,
        { headers: GITHUB_ACCEPT },
      );
      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        throw new Error(`github content read failed: ${response.status}`);
      }
      const body = (await response.json()) as GithubContentsResponse;
      if (body.type !== "file" || body.encoding !== "base64") {
        return null;
      }
      return Buffer.from(body.content, "base64").toString("utf-8");
    },

    async mintInstallationToken(repo, installationId) {
      if (!config) {
        throw new Error("github app credentials not configured; cannot mint an installation token");
      }
      const repositoryIds = [await numericRepoId(repo)];
      const jwt = signGithubAppJwt(config.appId, config.privateKey, new Date());
      const response = await fetch(
        `https://api.github.com/app/installations/${installationId}/access_tokens`,
        {
          method: "POST",
          headers: { ...GITHUB_ACCEPT, authorization: `Bearer ${jwt}`, "content-type": "application/json" },
          body: JSON.stringify({ repository_ids: repositoryIds, permissions: { contents: "write" } }),
        },
      );
      if (!response.ok) {
        throw new Error(`github installation token mint failed: ${response.status}`);
      }
      const body = (await response.json()) as GithubTokenResponse;
      return {
        token: body.token,
        expiresAt: new Date(body.expires_at),
        repositoryIds,
        permissions: { contents: "write" },
      };
    },

    async push(repo, branch, sha, token) {
      const refPath = `heads/${branch}`;
      const base = `https://api.github.com/repos/${repo.owner}/${repo.name}/git/refs/${refPath}`;
      const headers = { ...GITHUB_ACCEPT, authorization: `Bearer ${token}`, "content-type": "application/json" };
      const update = await fetch(base, { method: "PATCH", headers, body: JSON.stringify({ sha }) });
      if (update.ok) {
        return;
      }
      if (update.status === 422) {
        // 422 = the ref does not exist yet (the "patch a missing ref" case),
        // or it exists but sha is an ancestor we are told to keep. Treat a
        // missing ref as "create it" — this mirrors the seam-3 rule that a
        // 422 on an existing ref is success (idempotent by shape).
        const create = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.name}/git/refs`, {
          method: "POST",
          headers,
          body: JSON.stringify({ ref: `refs/${refPath}`, sha }),
        });
        if (!create.ok && create.status !== 422) {
          throw new Error(`github push failed: ${create.status}`);
        }
        return;
      }
      throw new Error(`github push failed: ${update.status}`);
    },
  };
}
