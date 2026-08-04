/**
 * The real git operations against a real git binary and a real local "remote"
 * (a bare repo) — proving the Runner's half of the git-as-a-bus transport
 * end to end: fetch the base ref, commit the turn's changes, push the named
 * branch, and confirm the remote sees it. The installation token is a dummy:
 * against a local path remote git never touches HTTP, but the *command shape*
 * (token delivered via `http.extraHeader`, never in argv) is what's under
 * test, and `revokeInstallationToken`'s wire shape is asserted against an
 * injected fake fetch.
 */
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGitOps, type GitOps } from "../ops.js";

const execFileAsync = promisify(execFile);

const exec: (file: string, args: string[], opts?: { cwd?: string }) => Promise<{ stdout: string; stderr: string }> = (
  file,
  args,
  opts,
) => execFileAsync(file, args, opts).catch((error) => Promise.reject(error)) as never;

let baseSha = "";
let origin = "";
let cloneDir = "";
const cleanup: string[] = [];

async function makeRemote(): Promise<void> {
  const source = await mkdtemp(path.join(tmpdir(), "factory-git-source-"));
  const bare = await mkdtemp(path.join(tmpdir(), "factory-git-origin-"));
  cleanup.push(source, bare);
  await exec("git", ["init", "-q", "-b", "main", source]);
  await writeFile(path.join(source, "a.txt"), "a\n");
  await exec("git", ["-C", source, "add", "-A"]);
  await exec("git", ["-C", source, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
  baseSha = (await exec("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();
  await exec("git", ["clone", "-q", "--bare", source, bare]);
  origin = bare;
  cloneDir = await mkdtemp(path.join(tmpdir(), "factory-git-clone-"));
  cleanup.push(cloneDir);
}

beforeAll(async () => {
  await makeRemote();
});

afterAll(async () => {
  for (const dir of cleanup) {
    await execFileAsync("rm", ["-rf", dir]);
  }
});

describe("git ops: the Runner's bus transport", () => {
  it("ensureRepo → fetch → commitAll → push, and the remote sees the named branch", async () => {
    const git: GitOps = createGitOps(exec);
    const dummyToken = "ghs_installation_dummy";

    await git.ensureRepo(cloneDir, origin);
    await git.fetch(cloneDir, origin, baseSha, dummyToken);

    // The turn made changes in the worktree.
    await writeFile(path.join(cloneDir, "work.txt"), "built\n");
    const commitSha = await git.commitAll(cloneDir, "factory: build (run/run_1/build/t1-a1)");
    expect(commitSha).not.toBe(baseSha);

    await git.push(cloneDir, origin, commitSha, "run/run_1/build/t1-a1", dummyToken);

    // The remote — the bus — now has the named branch at exactly that sha.
    const remoteSha = (await exec("git", ["-C", origin, "rev-parse", "refs/heads/run/run_1/build/t1-a1"])).stdout.trim();
    expect(remoteSha).toBe(commitSha);
  });

  it("commitAll on a clean worktree returns HEAD without committing", async () => {
    const git: GitOps = createGitOps(exec);
    const head = (await exec("git", ["-C", cloneDir, "rev-parse", "HEAD"])).stdout.trim();
    const again = await git.commitAll(cloneDir, "nothing to do");
    expect(again).toBe(head);
  });

  it("refHead resolves a ref that exists in the clone and rejects one that does not", async () => {
    const git: GitOps = createGitOps(exec);
    // The branch the previous push created lives on the remote only — a local
    // refHead for it is exactly what the executor's `.catch(() => sha)`
    // fallback is for (a clean turn where the command never committed).
    await expect(git.refHead(cloneDir, "refs/heads/run/run_1/build/t1-a1")).rejects.toThrow();
    // A ref the clone actually has resolves to the clone's own HEAD.
    const head = (await exec("git", ["-C", cloneDir, "rev-parse", "HEAD"])).stdout.trim();
    expect(await git.refHead(cloneDir, "refs/heads/main")).toBe(head);
  });

  it("diff returns the text between base and head — the materialized diff artifact", async () => {
    const git: GitOps = createGitOps(exec);
    const base = (await exec("git", ["-C", cloneDir, "rev-parse", "HEAD"])).stdout.trim();

    // The turn changes the worktree and commits; head advances past base.
    await writeFile(path.join(cloneDir, "changed.txt"), "v1\n");
    const head = await git.commitAll(cloneDir, "factory: materialize");
    await writeFile(path.join(cloneDir, "changed.txt"), "v2\n");

    const diff = await git.diff(cloneDir, base, head);
    expect(diff).toContain("+v1\n");
    // Deterministic output — never colorized.
    expect(diff).not.toContain("\u001b[");

    // An empty diff (nothing between two refs) is still a valid result — not
    // an error — so a clean turn can materialize an empty diff artifact.
    expect(await git.diff(cloneDir, head, head)).toBe("");
  });

  it("revokeInstallationToken calls DELETE /installation/token with the token as bearer — teardown without the App credential", async () => {
    let seen: { method: string; url: string; authorization: string | null } | null = null;
    const git: GitOps = createGitOps(exec, async (token: string) => {
      seen = { method: "DELETE", url: "https://api.github.com/installation/token", authorization: `Bearer ${token}` };
    });
    await git.revokeInstallationToken("ghs_to_revoke");
    expect(seen).toEqual({ method: "DELETE", url: "https://api.github.com/installation/token", authorization: "Bearer ghs_to_revoke" });
  });
});
