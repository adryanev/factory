/**
 * In-memory fake for `GitHost` (see `src/domain/git-host.ts`). Tests register
 * files at a given ref before triggering a Run, so the seam-1 rig never
 * dials out to github.com.
 */
import { RefNotFoundError, type GitHost, type RepoRef } from "../../src/domain/git-host.js";

export interface FakeGitHost extends GitHost {
  /** Registers `ref` as resolving to `sha` for `repo`. */
  registerRef(repo: RepoRef, ref: string, sha: string): void;
  /** Registers a file's content at an exact `sha` for `repo`. */
  registerFile(repo: RepoRef, sha: string, path: string, content: string): void;
}

function repoKey(repo: RepoRef): string {
  return `${repo.owner}/${repo.name}`;
}

export function createFakeGitHost(): FakeGitHost {
  const refs = new Map<string, string>(); // "owner/name@ref" -> sha
  const files = new Map<string, string>(); // "owner/name@sha:path" -> content

  return {
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
  };
}
