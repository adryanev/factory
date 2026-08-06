/**
 * AC9 — the one test file that calls the **real** sandcastle (`@ai-hero/
 * sandcastle`, pinned exactly): three internal behaviors that are not public
 * contract and break silently on an upgrade (spec: "contract test terhadap
 * sandcastle sungguhan atas tiga perilaku internal yang patah senyap").
 *
 * None of them needs a docker daemon: they run through our own host provider
 * (`host-provider.ts`) or sandcastle's built-in `noSandbox()`, so the suite
 * stays fast and portable. Each test builds a throwaway git repo, drives
 * real `run()`, and asserts the behavior holds.
 *
 * The three behaviors:
 *  1. the session-capture gate — `tag: "bind-mount"` participates in
 *     session capture, `tag: "none"` silently disables it (spec: "tag
 *     'none' mematikan session capture secara senyap");
 *  2. the worktree path passed to a bind-mount provider's `create()` is used
 *     **verbatim** — files the command writes land exactly there, and the
 *     provider's handle reports the same path back;
 *  3. sandcastle's idle timer resets on every line of output — a command
 *     that keeps emitting past its own idle window does not get killed.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createBindMountSandboxProvider, run, type AgentProvider } from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import { createFactoryHostProvider } from "./host-provider.js";
import { createHostProcessControl } from "./host-process.js";

const execFileAsync = promisify(execFile);

/**
 * The shape of `AgentSessionStorage` sandcastle's session-capture gate
 * touches (`captureSessions && sessionStorage && sessionId && handle`).
 * Sandcastle does not export the interface from its entry point, so the
 * contract test declares the structural subset it drives.
 */
interface SessionStorageLike {
  captureToHost(args: { hostCwd: string; sandboxCwd: string; sessionId: string; handle: unknown }): Promise<void>;
  resumeIntoSandbox(args: { hostCwd: string; sandboxCwd: string; sessionId: string; handle: unknown }): Promise<void>;
  readHostSession(cwd: string, sessionId: string): Promise<string | undefined>;
  existsOnHost(cwd: string, sessionId: string): Promise<boolean>;
  hostSessionFilePath(cwd: string, sessionId: string): string | undefined;
  findByIdOnHost(sessionId: string): Promise<{ path: string | undefined; searchedRoot: string }>;
}

/** A throwaway git repo for sandcastle to run against. */
async function makeTempGitRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "factory-sandcastle-"));
  await execFileAsync("git", ["init", "-q", "-b", "main", dir]);
  await writeFile(path.join(dir, "a.txt"), "a\n");
  await execFileAsync("git", ["-C", dir, "add", "-A"]);
  await execFileAsync("git", ["-C", dir, "-c", "user.name=contract", "-c", "user.email=contract@factory", "commit", "-q", "-m", "init"]);
  return dir;
}

/** A fake agent provider whose "agent" is a shell command — the only agent-shaped thing a `run:` step would ever be. */
function shellProvider(
  command: string,
  options: { captureSessions?: boolean; sessionStorage?: SessionStorageLike } = {},
): AgentProvider {
  return {
    name: "factory-contract-shell",
    env: {},
    captureSessions: options.captureSessions ?? false,
    ...(options.sessionStorage ? { sessionStorage: options.sessionStorage } : {}),
    buildPrintCommand: () => ({ command }),
    parseStreamLine: (line: string) =>
      line.startsWith("SESSION:")
        ? [{ type: "session_id" as const, sessionId: line.slice("SESSION:".length) }]
        : [],
  };
}

function fakeSessionStorage(tag: string): SessionStorageLike & { tag: string; captures: string[] } {
  const captures: string[] = [];
  return {
    tag,
    captures,
    async captureToHost(args: { sessionId: string }) {
      captures.push(args.sessionId);
    },
    async resumeIntoSandbox() {},
    async readHostSession() {
      return undefined;
    },
    async existsOnHost() {
      return false;
    },
    hostSessionFilePath() {
      return undefined;
    },
    async findByIdOnHost() {
      return { path: undefined, searchedRoot: "/tmp" };
    },
  };
}

const HOST_PROVIDER = createFactoryHostProvider({ hostProcess: createHostProcessControl() });

const repoDirs: string[] = [];

async function runShell(
  command: string,
  options: { branchStrategy?: { type: "head" } | { type: "branch"; branch: string; baseBranch?: string }; idleTimeoutSeconds?: number } = {},
) {
  const repoDir = await makeTempGitRepo();
  repoDirs.push(repoDir);
  return run({
    agent: shellProvider(command),
    sandbox: HOST_PROVIDER,
    cwd: repoDir,
    prompt: "run",
    maxIterations: 1,
    completionSignal: [],
    ...(options.idleTimeoutSeconds !== undefined ? { idleTimeoutSeconds: options.idleTimeoutSeconds } : {}),
    branchStrategy: options.branchStrategy ?? { type: "head" },
  });
}

afterEach(async () => {
  await Promise.all(repoDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("sandcastle contract: session-capture gate", () => {
  it(
    "tag 'bind-mount' participates in session capture when the provider opts in",
    // Real session capture copies the JSONL out of the worktree; under a
    // concurrently-loaded `pnpm -r run test` (the control-plane seam-1 suite
    // boots Postgres containers at the same time) this can stretch past
    // vitest's default 5s timeout. Same guard as the idle-timer test below.
    { timeout: 20_000 },
    async () => {
      const storage = fakeSessionStorage("bind-mount");
      const repoDir = await makeTempGitRepo();
      repoDirs.push(repoDir);

      const result = await run({
        agent: shellProvider("echo SESSION:sess-bind", { captureSessions: true, sessionStorage: storage }),
        sandbox: HOST_PROVIDER,
        cwd: repoDir,
        prompt: "run",
        maxIterations: 1,
        completionSignal: [],
        branchStrategy: { type: "head" },
      });
      expect(result.stdout).toContain("SESSION:sess-bind");
      // The gate opened: a session id was produced and the handle was a
      // bind-mount handle, so captureToHost ran exactly once.
      expect(storage.captures).toEqual(["sess-bind"]);
    },
  );

  it("tag 'none' silently disables session capture — no capture, no error", async () => {
    const storage = fakeSessionStorage("none");
    const repoDir = await makeTempGitRepo();
    repoDirs.push(repoDir);

    const result = await run({
      agent: shellProvider("echo SESSION:sess-none", { captureSessions: true, sessionStorage: storage }),
      sandbox: noSandbox(),
      cwd: repoDir,
      prompt: "run",
      maxIterations: 1,
      completionSignal: [],
      branchStrategy: { type: "head" },
    });
    expect(result.stdout).toContain("SESSION:sess-none");
    // The same provider shape, same captureSessions/sessionStorage opt-in —
    // only the tag changed, and capture silently did not happen.
    expect(storage.captures).toEqual([]);
  });

  it("a provider that never opts in does not capture, whatever its tag", async () => {
    const storage = fakeSessionStorage("no-opt-in");
    const repoDir = await makeTempGitRepo();
    repoDirs.push(repoDir);

    const result = await run({
      agent: shellProvider("echo SESSION:sess-optout", { captureSessions: false, sessionStorage: storage }),
      sandbox: HOST_PROVIDER,
      cwd: repoDir,
      prompt: "run",
      maxIterations: 1,
      completionSignal: [],
      branchStrategy: { type: "head" },
    });
    expect(result.stdout).toContain("SESSION:sess-optout");
    expect(storage.captures).toEqual([]);
  });
});

describe("sandcastle contract: worktree path verbatim", () => {
  it("the branch-strategy worktree path is passed to the provider verbatim and files land exactly there", async () => {
    const seenPaths: string[] = [];
    const createHandle = (HOST_PROVIDER as unknown as {
      create: (options: { worktreePath: string; hostRepoPath: string; mounts: unknown[]; env: Record<string, string> }) => Promise<import("@ai-hero/sandcastle").BindMountSandboxHandle>;
    }).create;
    const recordingProvider = createBindMountSandboxProvider({
      name: "recording-host",
      create: async (options) => {
        seenPaths.push(options.worktreePath);
        return createHandle(options);
      },
    });

    const repoDir = await makeTempGitRepo();
    repoDirs.push(repoDir);
    const branch = "contract/verbatim-1";

    const result = await run({
      agent: shellProvider("echo payload > written.txt"),
      sandbox: recordingProvider,
      cwd: repoDir,
      prompt: "run",
      maxIterations: 1,
      completionSignal: [],
      branchStrategy: { type: "branch", branch, baseBranch: "main" },
    });

    expect(seenPaths).toHaveLength(1);
    const worktreePath = seenPaths[0]!;
    // The path sandcastle hands over lives under .sandcastle/worktrees/ and
    // is the branch with slashes turned into dashes — but the *verbatim*
    // guarantee is that the command's cwd is that exact path, so the file it
    // wrote is readable back there, untouched and un-rewritten.
    expect(worktreePath).toMatch(/\.sandcastle[/\\]worktrees[/\\]/);
    expect(await readFile(path.join(worktreePath, "written.txt"), "utf-8")).toBe("payload\n");
    // The run reports the same branch and left the worktree preserved (dirty).
    expect(result.branch).toBe(branch);
    expect(result.preservedWorktreePath).toBe(worktreePath);
  });
});

describe("sandcastle contract: idle timer resets on each output", () => {
  it(
    "a command emitting output beyond its idle window is not killed — every line resets the timer",
    // Real `sleep 0.5` ticks under a concurrently-loaded `pnpm -r run test`
    // can stretch past vitest's default 5s timeout (the control-plane seam-1
    // suite boots Postgres containers at the same time). The behavior under
    // test — the timer resets on output — is unaffected by a wider window.
    { timeout: 20_000 },
    async () => {
      const started = Date.now();
      // Six ticks at 0.5s apart run ~3s total against a 2s idle window: the
      // 1.5s slack absorbs machine jitter under a loaded test runner, while the
      // total still outlives the window — proving the timer resets on every
      // line rather than measuring the whole run.
      const result = await runShell("for i in 1 2 3 4 5 6; do echo tick-$i; sleep 0.5; done", {
        idleTimeoutSeconds: 2,
      });
      const elapsed = Date.now() - started;

      // If the idle timer did NOT reset on output, the run would have failed at
      // 2s with an AgentIdleTimeoutError. It ran the full ~3s instead.
      expect(result.stdout).toContain("tick-1");
      expect(result.stdout).toContain("tick-6");
      expect(elapsed).toBeGreaterThanOrEqual(2500);
    },
  );
});
