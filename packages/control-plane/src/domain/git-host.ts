/**
 * Narrow interface, one real implementation — the shape issue #6 ("Git
 * sebagai bus, Step run:, dan GitHost") will grow into the full `GitHost`
 * (push, installation-token minting, branch naming). This issue only needs
 * the read half: resolve a ref to a commit SHA, then read a file's content
 * at that exact SHA. Kept behind this interface so seam-1 tests never dial
 * out to github.com — see `test/seam1/fake-git-host.ts`.
 *
 * The real implementation below reads over unauthenticated `fetch`, which
 * only works for public repositories. `repositories.githubAppInstallationId`
 * already exists in the schema for issue #6/#8 to wire in an installation
 * token; this file deliberately does not reach for it — building that out
 * now would be building GitHost, which is explicitly not this issue's job.
 */

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

export interface GitHost {
  /** Resolves a branch (or other ref) to the commit SHA it currently points at. Throws {@link RefNotFoundError} if the ref does not exist. */
  resolveRef(repo: RepoRef, ref: string): Promise<string>;
  /** Reads a file's raw content at an exact commit SHA. Returns `null` if no file exists at that path — a missing file is an expected outcome, not an error. */
  readFile(repo: RepoRef, sha: string, path: string): Promise<string | null>;
}

interface GithubCommitResponse {
  sha: string;
}

interface GithubContentsResponse {
  type: string;
  encoding: string;
  content: string;
}

/** Real implementation over the public GitHub REST API. See the file-level doc for the auth gap this leaves for issue #6/#8. */
export function createGithubHost(): GitHost {
  return {
    async resolveRef(repo, ref) {
      const response = await fetch(
        `https://api.github.com/repos/${repo.owner}/${repo.name}/commits/${encodeURIComponent(ref)}`,
        { headers: { accept: "application/vnd.github+json" } },
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
        { headers: { accept: "application/vnd.github+json" } },
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
  };
}
