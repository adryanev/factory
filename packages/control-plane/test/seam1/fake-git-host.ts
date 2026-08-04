/**
 * In-memory fake for `GitHost` (see `src/domain/git-host.ts`). Tests register
 * files at a given ref before triggering a Run, so the seam-1 rig never
 * dials out to github.com. Issue #6 grew the interface with minting and
 * push, so the fake records both: a test can assert that `/claim` mints
 * exactly two narrow tokens per turn (spec: "mint dua kali per giliran") and
 * that the Runner-protocol path never pushes on the control plane's behalf.
 *
 * Issue #17 grows the fake again with the pull-request surface — find /
 * create / status — and records every call, so a test can assert the
 * find-then-create idempotency order, the 422-as-success adoption, the
 * two-permission mint, and the status posted with the Run page as
 * `target_url` (AC6/AC7/AC8). Tests pre-register an open PR to exercise the
 * adopt path; `failNext*` knobs force transient failures to prove retry.
 */
import {
  PullRequestConflictError,
  RefNotFoundError,
  type CommitStatusInput,
  type GitHost,
  type InstallationToken,
  type PullRequest,
  type RepoRef,
} from "../../src/domain/git-host.js";

export interface MintRecord {
  repo: RepoRef;
  installationId: number;
  permissions: Record<string, string>;
}

export interface PushRecord {
  repo: RepoRef;
  branch: string;
  sha: string;
  token: string;
}

export interface PullRequestRecord {
  repo: RepoRef;
  number: number;
  head: string;
  base: string;
  title: string;
  body: string;
  headSha: string;
  htmlUrl: string;
  state: "open";
  /** True when this PR came from `findOpenPullRequest` (adopted) rather than `createPullRequest`. */
  adopted?: boolean;
}

export interface StatusRecord {
  repo: RepoRef;
  sha: string;
  status: CommitStatusInput;
  token: string;
}

export interface FindRecord {
  repo: RepoRef;
  head: string;
  base: string;
}

export interface FakeGitHost extends GitHost {
  /** Registers `ref` as resolving to `sha` for `repo`. */
  registerRef(repo: RepoRef, ref: string, sha: string): void;
  /** Registers a file's content at an exact `sha` for `repo`. */
  registerFile(repo: RepoRef, sha: string, path: string, content: string): void;
  /** Pre-registers an open PR for a (repo, head, base) pair — the adopt path's answer to `findOpenPullRequest`. */
  registerOpenPullRequest(repo: RepoRef, head: string, base: string, pr: Partial<PullRequestRecord>): void;
  /** Every `mintInstallationToken` call, in order — assert count and scoping here. */
  minted: MintRecord[];
  /** Every `push` call, in order. */
  pushed: PushRecord[];
  /** Every PR opened or adopted, in order — a test asserts the per-branch PRs and their repos here. */
  pullRequests: PullRequestRecord[];
  /** Every Commit Status posted, in order — assert the Run-page `target_url` here. */
  statuses: StatusRecord[];
  /** Every `findOpenPullRequest` call, in order — proves the find-then-create idempotency order. */
  finds: FindRecord[];
  /** Force the next N mints to fail — proves a claim whose minting fails un-leases the row. */
  failNextMints: number;
  /** Force the next N `createPullRequest` calls to throw a transient 5xx — proves the retry path. */
  failNextCreates: number;
  /** Force the next N `postCommitStatus` calls to throw a transient 5xx — proves status is retried too. */
  failNextStatuses: number;
  /** Make the next `createPullRequest` throw 422 AND leave an open PR behind — the raced-create adoption path (AC6). */
  conflictOnNextCreate: boolean;
  /** Clears every recorded call and registered fixture — call between tests sharing one rig. */
  reset(): void;
}

function repoKey(repo: RepoRef): string {
  return `${repo.owner}/${repo.name}`;
}

export function createFakeGitHost(): FakeGitHost {
  const refs = new Map<string, string>(); // "owner/name@ref" -> sha
  const files = new Map<string, string>(); // "owner/name@sha:path" -> content
  const openPrs = new Map<string, PullRequestRecord>(); // "owner/name|head|base" -> pr
  let mintCount = 0;
  let prCounter = 0;

  return {
    minted: [],
    pushed: [],
    pullRequests: [],
    statuses: [],
    finds: [],
    failNextMints: 0,
    failNextCreates: 0,
    failNextStatuses: 0,
    conflictOnNextCreate: false,

    reset() {
      this.minted.length = 0;
      this.pushed.length = 0;
      this.pullRequests.length = 0;
      this.statuses.length = 0;
      this.finds.length = 0;
      this.failNextMints = 0;
      this.failNextCreates = 0;
      this.failNextStatuses = 0;
      this.conflictOnNextCreate = false;
      refs.clear();
      files.clear();
      openPrs.clear();
    },

    registerRef(repo, ref, sha) {
      refs.set(`${repoKey(repo)}@${ref}`, sha);
    },
    registerFile(repo, sha, path, content) {
      files.set(`${repoKey(repo)}@${sha}:${path}`, content);
    },
    registerOpenPullRequest(repo, head, base, pr) {
      prCounter += 1;
      const record: PullRequestRecord = {
        repo,
        number: pr.number ?? 9000 + prCounter,
        head,
        base,
        title: pr.title ?? "pre-registered PR",
        body: pr.body ?? "",
        headSha: pr.headSha ?? `fake-head-sha-${prCounter}`,
        htmlUrl: pr.htmlUrl ?? `https://github.com/${repo.owner}/${repo.name}/pull/${9000 + prCounter}`,
        state: "open",
        adopted: true,
      };
      openPrs.set(`${repoKey(repo)}|${head}|${base}`, record);
    },
    async resolveRef(repo, ref) {
      const sha = refs.get(`${repoKey(repo)}@${ref}`);
      if (!sha) {
        throw new RefNotFoundError(repo, ref);
      }
      return sha;
    },
    async readFile(repo, sha, path) {
      return files.get(`${repoKey(repo)}@${sha}:${path}`) ?? null;
    },
    async mintInstallationToken(repo, installationId, permissions = { contents: "write" }): Promise<InstallationToken> {
      if (this.failNextMints > 0) {
        this.failNextMints -= 1;
        throw new Error("github installation token mint failed: 503");
      }
      mintCount += 1;
      this.minted.push({ repo, installationId, permissions });
      const expiresAt = new Date("2026-01-01T01:00:00.000Z"); // 1h after the rig's fixed clock.
      return {
        token: `fake-git-token-${mintCount}`,
        expiresAt,
        repositoryIds: [1000 + mintCount],
        permissions,
      };
    },
    async push(repo, branch, sha, token) {
      this.pushed.push({ repo, branch, sha, token });
    },
    async findOpenPullRequest(repo, head, base): Promise<PullRequest | null> {
      this.finds.push({ repo, head, base });
      const record = openPrs.get(`${repoKey(repo)}|${head}|${base}`);
      if (!record) return null;
      return { number: record.number, htmlUrl: record.htmlUrl, headSha: record.headSha, state: "open" };
    },
    async createPullRequest(repo, input, token): Promise<PullRequest> {
      if (this.failNextCreates > 0) {
        this.failNextCreates -= 1;
        throw new Error("github pull request create failed: 503");
      }
      const existing = openPrs.get(`${repoKey(repo)}|${input.head}|${input.base}`);
      if (existing || this.conflictOnNextCreate) {
        // The raced-create case: someone else's PR exists (or appears between
        // our find and create). Register the record so the executor's re-find
        // adopts it, then throw the 422 the way GitHub would.
        if (this.conflictOnNextCreate) {
          this.conflictOnNextCreate = false;
          prCounter += 1;
          const racing: PullRequestRecord = {
            repo,
            number: 9000 + prCounter,
            head: input.head,
            base: input.base,
            title: input.title,
            body: input.body,
            headSha: `fake-head-sha-${prCounter}`,
            htmlUrl: `https://github.com/${repo.owner}/${repo.name}/pull/${9000 + prCounter}`,
            state: "open",
            adopted: true,
          };
          openPrs.set(`${repoKey(repo)}|${input.head}|${input.base}`, racing);
          this.pullRequests.push(racing);
        }
        throw new PullRequestConflictError(repo, input.head, input.base, "A pull request already exists.");
      }
      prCounter += 1;
      const record: PullRequestRecord = {
        repo,
        number: 9000 + prCounter,
        head: input.head,
        base: input.base,
        title: input.title,
        body: input.body,
        headSha: `fake-head-sha-${prCounter}`,
        htmlUrl: `https://github.com/${repo.owner}/${repo.name}/pull/${9000 + prCounter}`,
        state: "open",
      };
      openPrs.set(`${repoKey(repo)}|${input.head}|${input.base}`, record);
      this.pullRequests.push(record);
      return { number: record.number, htmlUrl: record.htmlUrl, headSha: record.headSha, state: "open" };
    },
    async postCommitStatus(repo, sha, status, token) {
      if (this.failNextStatuses > 0) {
        this.failNextStatuses -= 1;
        throw new Error("github commit status post failed: 503");
      }
      this.statuses.push({ repo, sha, status, token });
    },
  };
}
