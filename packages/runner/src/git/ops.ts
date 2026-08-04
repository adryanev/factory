/**
 * The Runner's half of the git-as-a-bus transport (spec: "git remote jadi
 * bus antar step ... transportnya kita bangun sendiri"): host-side `git`
 * operations that fetch the base ref, commit the turn's changes, push the
 * named branch, and revoke the installation tokens at teardown.
 *
 * Every command passes the token through `http.extraHeader` — never in the
 * URL, never in an argument, and never in the sandbox environment (the
 * sandbox is a separate concern in `agent-runtime`, which takes no token at
 * all). This is the whole point of AC5: the token travels only on the host.
 *
 * The `git` binary is injected via `GitExec` so unit tests can prove the
 * command shapes without a real remote; `createSystemGitOps` wires the real
 * `child_process.execFile`.
 */
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { promisify } from "node:util";

export interface GitExec {
  (file: string, args: string[], options?: { cwd?: string; env?: Record<string, string> }): Promise<{
    stdout: string;
    stderr: string;
  }>;
}

export interface GitOps {
  /** Makes `cloneDir` a git repo with `origin` set — a fresh clone dir is created if needed. */
  ensureRepo(cloneDir: string, repoUrl: string): Promise<void>;
  /** Fetches the base `ref` (a commit sha) from `origin`, authenticated with `token`. */
  fetch(cloneDir: string, repoUrl: string, ref: string, token: string): Promise<void>;
  /** Commits every change under `dir` as the factory bot; returns the new HEAD sha (or HEAD if nothing to commit). */
  commitAll(dir: string, message: string): Promise<string>;
  /** Resolves a ref in `dir` to a sha — throws when the ref does not exist. */
  refHead(dir: string, ref: string): Promise<string>;
  /**
   * The text diff between `base` and `head` — what this turn changed. The
   * materialized diff artifact (spec: "Diff dimaterialisasi jadi blob saat
   * StepRun berakhir, sehingga branch bebas dihapus") is this exact output,
   * uploaded by the Runner at the turn's end so the branch can be deleted
   * without the change being lost.
   */
  diff(dir: string, base: string, head: string): Promise<string>;
  /** Pushes `sha` to `refs/heads/<branch>` on `origin`, authenticated with `token`. */
  push(cloneDir: string, repoUrl: string, sha: string, branch: string, token: string): Promise<void>;
  /** Revokes an installation token at teardown — `DELETE /installation/token`, authenticated with the token itself. */
  revokeInstallationToken(token: string): Promise<void>;
}

export const GIT_BOT_IDENTITY = { name: "factory[bot]", email: "factory-runner@factory.local" };

/** The header git sends on every authenticated command — keeps the token out of URLs and argv. */
function authHeader(token: string): string {
  return `AUTHORIZATION: Bearer ${token}`;
}

export function createGitOps(exec: GitExec, revokeToken?: (token: string) => Promise<void>): GitOps {
  const git = (cwd: string, args: string[], extraEnv: Record<string, string> = {}) =>
    exec("git", args, { cwd, env: { ...extraEnv } });

  const gitWithAuth = (cwd: string, token: string, args: string[]) =>
    git(cwd, args, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: authHeader(token) });

  return {
    async ensureRepo(cloneDir, repoUrl) {
      const isRepo = await exec("git", ["rev-parse", "--git-dir"], { cwd: cloneDir })
        .then(() => true)
        .catch(() => false);
      if (!isRepo) {
        await mkdir(cloneDir, { recursive: true });
        await git(cloneDir, ["init", "-q", "-b", "main"]);
      }
      const hasOrigin = await exec("git", ["remote", "get-url", "origin"], { cwd: cloneDir })
        .then(() => true)
        .catch(() => false);
      if (!hasOrigin) {
        await git(cloneDir, ["remote", "add", "origin", repoUrl]);
      }
    },

    async fetch(cloneDir, _repoUrl, ref, token) {
      await gitWithAuth(cloneDir, token, ["fetch", "-q", "origin", ref]);
    },

    async commitAll(dir, message) {
      const status = (await git(dir, ["status", "--porcelain"])).stdout.trim();
      if (status.length === 0) {
        return (await git(dir, ["rev-parse", "HEAD"])).stdout.trim();
      }
      await git(dir, ["add", "-A"]);
      await git(dir, [
        "-c",
        `user.name=${GIT_BOT_IDENTITY.name}`,
        "-c",
        `user.email=${GIT_BOT_IDENTITY.email}`,
        "commit",
        "-q",
        "-m",
        message,
      ]);
      return (await git(dir, ["rev-parse", "HEAD"])).stdout.trim();
    },

    async refHead(dir, ref) {
      const { stdout } = await git(dir, ["rev-parse", "--verify", ref]);
      return stdout.trim();
    },

    async diff(dir, base, head) {
      // `--no-color` keeps the output deterministic whether or not the
      // process has a tty; `--exit-code` is deliberately NOT used — an empty
      // diff (a clean turn) is still valid material for the diff artifact.
      const { stdout } = await git(dir, ["diff", "--no-color", base, head]);
      return stdout;
    },

    async push(cloneDir, _repoUrl, sha, branch, token) {
      await gitWithAuth(cloneDir, token, ["push", "origin", `${sha}:refs/heads/${branch}`]);
    },

    async revokeInstallationToken(token) {
      if (revokeToken) {
        await revokeToken(token);
        return;
      }
      const response = await fetch("https://api.github.com/installation/token", {
        method: "DELETE",
        headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}` },
      });
      if (!response.ok && response.status !== 404) {
        // 404 = already revoked/expired — teardown is best-effort.
        throw new Error(`github installation token revoke failed: ${response.status}`);
      }
    },
  };
}

export function createSystemGitOps(): GitOps {
  const execFileAsync = promisify(execFile) as GitExec;
  return createGitOps(execFileAsync);
}
