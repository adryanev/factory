/**
 * In-memory fake for `GitHost` (see `src/domain/git-host.ts`). Tests register
 * files at a given ref before triggering a Run, so the seam-1 rig never
 * dials out to github.com. Issue #6 grew the interface with minting and
 * push, so the fake records both: a test can assert that `/claim` mints
 * exactly two narrow tokens per turn (spec: "mint dua kali per giliran") and
 * that the Runner-protocol path never pushes on the control plane's behalf.
 */
import { RefNotFoundError, type GitHost, type InstallationToken, type RepoRef } from "../../src/domain/git-host.js";

export interface MintRecord {
  repo: RepoRef;
  installationId: number;
}

export interface PushRecord {
  repo: RepoRef;
  branch: string;
  sha: string;
  token: string;
}

export interface FakeGitHost extends GitHost {
  /** Registers `ref` as resolving to `sha` for `repo`. */
  registerRef(repo: RepoRef, ref: string, sha: string): void;
  /** Registers a file's content at an exact `sha` for `repo`. */
  registerFile(repo: RepoRef, sha: string, path: string, content: string): void;
  /** Every `mintInstallationToken` call, in order — assert count and scoping here. */
  minted: MintRecord[];
  /** Every `push` call, in order. */
  pushed: PushRecord[];
  /** Force the next N mints to fail — proves a claim whose minting fails un-leases the row. */
  failNextMints: number;
}

function repoKey(repo: RepoRef): string {
  return `${repo.owner}/${repo.name}`;
}

export function createFakeGitHost(): FakeGitHost {
  const refs = new Map<string, string>(); // "owner/name@ref" -> sha
  const files = new Map<string, string>(); // "owner/name@sha:path" -> content
  let mintCount = 0;

  return {
    minted: [],
    pushed: [],
    failNextMints: 0,

    registerRef(repo, ref, sha) {
      refs.set(`${repoKey(repo)}@${ref}`, sha);
    },
    registerFile(repo, sha, path, content) {
      files.set(`${repoKey(repo)}@${sha}:${path}`, content);
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
    async mintInstallationToken(repo, installationId): Promise<InstallationToken> {
      if (this.failNextMints > 0) {
        this.failNextMints -= 1;
        throw new Error("github installation token mint failed: 503");
      }
      mintCount += 1;
      this.minted.push({ repo, installationId });
      const expiresAt = new Date("2026-01-01T01:00:00.000Z"); // 1h after the rig's fixed clock.
      return {
        token: `fake-git-token-${mintCount}`,
        expiresAt,
        repositoryIds: [1000 + mintCount],
        permissions: { contents: "write" },
      };
    },
    async push(repo, branch, sha, token) {
      this.pushed.push({ repo, branch, sha, token });
    },
  };
}
