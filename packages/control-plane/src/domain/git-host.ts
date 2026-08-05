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
 *    needing the App credential (see `packages/runner`). The optional
 *    `permissions` parameter lets a caller mint a different write surface —
 *    exactly the one `kind: pull-request` execution uses (issue #17).
 *  - `push` — API-based push (Git Data API), consumed by seam-3 (issue 11's
 *    PR opening and the Pipeline editor), not by the Runner's own git CLI
 *    transport. Present here so the interface and its fake cover the whole
 *    seam now; 422 ("ref already exists") is treated as success, exactly the
 *    seam-3 acceptance criterion.
 *  - `findOpenPullRequest` / `createPullRequest` / `postCommitStatus` — the
 *    three calls `kind: pull-request` execution makes (issue #17), each with
 *    the idempotency semantics the spec locks: find-then-adopt, and a 422
 *    create treated as success (re-find and adopt). The whole write surface
 *    of this seam is exactly those two verbs, plus the status POST — there is
 *    deliberately no method to merge, comment, label, or write an issue, and
 *    the token minted for the pull-request Step carries only
 *    `{ pull_requests: write, statuses: write }` (no `contents`, so no merge;
 *    no `issues`, so no comments/labels/issue writes). That pairing is the
 *    structural half of AC8 ("nol komentar, nol label, nol tulisan ke issue,
 *    nol merge") — the other half is that no other method exists to call.
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

/**
 * A GitHub API call that returned a non-ok status. The `kind: pull-request`
 * executor reads `status` and `retryAfterSeconds` to drive its retry policy
 * (issue #17, AC2: "patuhi `Retry-After`"; backoff 5s fixed otherwise).
 */
export class GithubRequestError extends Error {
  readonly status: number;
  /** GitHub's `Retry-After` seconds when the response carried one, else null. */
  readonly retryAfterSeconds: number | null;

  constructor(message: string, status: number, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = "GithubRequestError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** The retry-after hint of a `Response`'s `Retry-After` header, or null. Exported for the unit test that proves GitHub's verbatim honor is parsed. */
export function retryAfterFrom(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (header === null) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/**
 * Thrown by `createPullRequest` on GitHub's 422 — "a pull request already
 * exists for this head/base pair" (or another validation failure). The
 * control-plane executor treats it as success-by-adoption (issue #17, AC6):
 * it re-runs `findOpenPullRequest` and adopts whatever is open. The 422 is
 * a signal, not an error, which is why it has its own type.
 */
export class PullRequestConflictError extends Error {
  constructor(repo: RepoRef, head: string, base: string, detail: string) {
    super(`pull request already exists for ${repo.owner}/${repo.name} ${head} -> ${base}: ${detail}`);
    this.name = "PullRequestConflictError";
  }
}

/** The minimal shape of a GitHub pull request the control plane records. */
export interface PullRequest {
  number: number;
  /** The HTML URL — what the Run page links to. */
  htmlUrl: string;
  /** The head commit SHA the PR opens from — what the Commit Status is posted to. */
  headSha: string;
  state: "open";
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

/**
 * The write surface of a `kind: pull-request` StepRun: open a PR and post a
 * Commit Status, and nothing else (issue #17, AC7/AC8). No `contents` (so no
 * merge — GitHub gates `PUT /pulls/{n}/merge` on the Contents permission), no
 * `issues` (so no labels/comments/issue writes). Creating a PR requires
 * `pull_requests`; the Commit Status API requires `statuses` — those are the
 * two permissions the spec means by "dua izin".
 */
export const PULL_REQUEST_WRITE_PERMISSIONS = { pull_requests: "write", statuses: "write" } as const;

/** The Commit Status a control-plane StepRun posts to its PR's head commit. */
export interface CommitStatusInput {
  state: "success";
  context: string;
  description: string;
  /** The field GitHub links in the PR checks area — the Run page URL (AC7). */
  targetUrl: string;
}

export interface GitHost {
  /** Resolves a branch (or other ref) to the commit SHA it currently points at. Throws {@link RefNotFoundError} if the ref does not exist. */
  resolveRef(repo: RepoRef, ref: string): Promise<string>;
  /** Reads a file's raw content at an exact commit SHA. Returns `null` if no file exists at that path — a missing file is an expected outcome, not an error. */
  readFile(repo: RepoRef, sha: string, path: string): Promise<string | null>;
  /** Mints a 1-hour installation access token scoped to `repo` (`repository_ids` = this repo alone). `installationId` is the GitHub App's numeric installation id for the repository. Defaults to `contents: write` (the Runner's fetch/push surface); `permissions` may narrow it further — `kind: pull-request` execution mints `{ pull_requests, statuses }`. */
  mintInstallationToken(
    repo: RepoRef,
    installationId: number,
    permissions?: Record<string, string>,
  ): Promise<InstallationToken>;
  /** Points the remote `branch` at `sha` through the Git Data API, authenticated with `token`. 422 (ref already exists) is treated as success — idempotent by shape. */
  push(repo: RepoRef, branch: string, sha: string, token: string): Promise<void>;
  /** The open PR for one head/base pair, or null. The idempotency search half of issue #17 (AC6): "cari PR yang cocok lalu adopsi". `head` is the branch name in this repo. */
  findOpenPullRequest(repo: RepoRef, head: string, base: string, token: string): Promise<PullRequest | null>;
  /** Opens a PR. Throws {@link PullRequestConflictError} on GitHub's 422 — the caller treats that as success and adopts. The only other write a `kind: pull-request` StepRun makes, besides the status. */
  createPullRequest(
    repo: RepoRef,
    input: { title: string; body: string; head: string; base: string },
    token: string,
  ): Promise<PullRequest>;
  /** Posts a Commit Status to a commit SHA — the checks-area link back to the Run page (issue #17, AC7). Checks API rejected by design. */
  postCommitStatus(repo: RepoRef, sha: string, status: CommitStatusInput, token: string): Promise<void>;
  /**
   * Lists the bare branch names under `prefix` (e.g. `run/<run-id>`) that
   * currently exist in `repo` — the retention sweep's half of "branch yatim
   * dari giliran yang mati ikut dibersihkan": the sweep deletes by prefix,
   * not by row, so a branch a dead turn pushed without ever recording it is
   * found too. Returns branches only; the caller never needs the SHAs.
   */
  listRefsByPrefix(repo: RepoRef, prefix: string, token: string): Promise<string[]>;
  /** Deletes one branch (bare name) from `repo`. A ref that is already gone is success, not an error — idempotent by shape, mirroring `push`'s 422 rule. */
  deleteRef(repo: RepoRef, branch: string, token: string): Promise<void>;
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

interface GithubPullRequestResponse {
  number: number;
  html_url: string;
  state: string;
  head: { sha: string };
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

    async mintInstallationToken(repo, installationId, permissions = { contents: "write" }) {
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
          body: JSON.stringify({ repository_ids: repositoryIds, permissions }),
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
        permissions,
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

    async findOpenPullRequest(repo, head, base, token) {
      const query = new URLSearchParams({
        state: "open",
        // GitHub's head filter is `user:ref-name` — for a PR inside one repo
        // the user is the repo owner, exactly what makes the filter unique.
        head: `${repo.owner}:${head}`,
        base,
      });
      const response = await fetch(
        `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls?${query}`,
        { headers: { ...GITHUB_ACCEPT, authorization: `Bearer ${token}` } },
      );
      if (!response.ok) {
        throw new GithubRequestError(
          `github pull request lookup failed: ${response.status}`,
          response.status,
          retryAfterFrom(response),
        );
      }
      const pulls = (await response.json()) as GithubPullRequestResponse[];
      const match = pulls.find((pull) => pull.state === "open");
      return match ? toPullRequest(match) : null;
    },

    async createPullRequest(repo, input, token) {
      const response = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.name}/pulls`, {
        method: "POST",
        headers: { ...GITHUB_ACCEPT, authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          title: input.title,
          head: input.head,
          base: input.base,
          body: input.body,
        }),
      });
      if (response.status === 422) {
        // 422 = "a pull request already exists for this head/base pair" (or a
        // validation failure). Issue #17 treats it as success-by-adoption — the
        // caller re-runs findOpenPullRequest — so it throws this typed signal
        // rather than an error the retry policy would burn attempts on.
        const detail = await response.text();
        throw new PullRequestConflictError(repo, input.head, input.base, detail);
      }
      if (!response.ok) {
        throw new GithubRequestError(
          `github pull request create failed: ${response.status}`,
          response.status,
          retryAfterFrom(response),
        );
      }
      return toPullRequest((await response.json()) as GithubPullRequestResponse);
    },

    async postCommitStatus(repo, sha, status, token) {
      const response = await fetch(
        `https://api.github.com/repos/${repo.owner}/${repo.name}/statuses/${sha}`,
        {
          method: "POST",
          headers: { ...GITHUB_ACCEPT, authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            state: status.state,
            context: status.context,
            description: status.description,
            target_url: status.targetUrl,
          }),
        },
      );
      if (!response.ok) {
        throw new GithubRequestError(
          `github commit status post failed: ${response.status}`,
          response.status,
          retryAfterFrom(response),
        );
      }
    },

    async listRefsByPrefix(repo, prefix, token) {
      // matching-refs returns every ref whose full name starts with
      // `refs/heads/<prefix>` — the sweep's per-Run branch set, recorded or
      // orphan. `prefix` is a bare branch prefix (`run/<run-id>`); the API
      // path keeps the slashes literal.
      const response = await fetch(
        `https://api.github.com/repos/${repo.owner}/${repo.name}/git/matching-refs/heads/${prefix}`,
        { headers: { ...GITHUB_ACCEPT, authorization: `Bearer ${token}` } },
      );
      if (!response.ok) {
        throw new GithubRequestError(
          `github ref listing failed: ${response.status}`,
          response.status,
          retryAfterFrom(response),
        );
      }
      const body = (await response.json()) as { refs: { ref: string }[] };
      const fullPrefix = `refs/heads/${prefix}`;
      return body.refs
        .map((entry) => entry.ref)
        .filter((ref) => ref.startsWith(fullPrefix))
        .map((ref) => ref.slice("refs/heads/".length));
    },

    async deleteRef(repo, branch, token) {
      const response = await fetch(
        `https://api.github.com/repos/${repo.owner}/${repo.name}/git/refs/heads/${branch}`,
        { method: "DELETE", headers: { ...GITHUB_ACCEPT, authorization: `Bearer ${token}` } },
      );
      // 422/404 = the ref is already gone — deleting twice is fine, exactly
      // the way `push` treats a 422 on an existing ref as success.
      if (!response.ok && response.status !== 422 && response.status !== 404) {
        throw new GithubRequestError(
          `github ref delete failed: ${response.status}`,
          response.status,
          retryAfterFrom(response),
        );
      }
    },
  };
}

function toPullRequest(pull: GithubPullRequestResponse): PullRequest {
  return {
    number: pull.number,
    htmlUrl: pull.html_url,
    headSha: pull.head.sha,
    state: "open",
  };
}
