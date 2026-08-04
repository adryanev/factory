/**
 * The turn surface of the `agent-runtime` seam: what a turn is, what it
 * returns, and the two host primitives the real implementation is built on
 * (docker CLI control + host process-group control). Everything sandcastle
 * touches lives behind the `TurnRuntimeDeps` injected into `runtime.ts` so
 * unit tests never dial docker or spawn real processes.
 *
 * Deliberately, `TurnSpec` carries **no** git token and no wall-clock
 * deadline:
 *
 *  - The token is the control plane's (minted at `/claim`); the Runner's
 *    host-side git uses it for fetch/push, and it must never reach the
 *    sandbox environment (spec: "Sandbox tidak pernah melewati
 *    contents:write"). By omitting it from the spec, the seam cannot pass it
 *    through — structurally, not by convention.
 *  - The one wall-clock is the control plane's lease (spec: "jam wall-clock
 *    hanya satu dan dipegang control plane"). The seam has no timeout field;
 *    sandcastle's idle/completion timers stay as-is because they measure the
 *    agent hanging, not wall-clock (issue 06-dag, "Satu jam").
 */
import type { CreateSandboxOptions, Sandbox } from "@ai-hero/sandcastle";

export type RunsOn = "docker" | "host";

export interface ShellTurnSpec {
  kind: "shell";
  /** The `run:` shell command, executed with the repo checked out at the named branch. */
  command: string;
  /** Host-side clone dir — the `cwd` anchor sandcastle creates its worktree under. */
  workingDirectory: string;
  /** The named branch this turn works on (see `@factory/shared`'s `stepRunBranchName`). */
  branch: string;
  /** Commit the named branch forks from — the StepRun's claimed base ref. */
  baseRef: string;
  runsOn: RunsOn;
  /** Docker image for the built-in docker provider (`docker` mode). */
  image: string;
  /** Per-StepRun docker network (`docker` mode) — the boundary `cancel()` stops containers on. */
  network: string;
  /** Streamed stdout line sink (a future live-tail/log-chunks consumer). */
  onLine?: (line: string) => void;
}

/** The seam grows by discriminated union — issue 9 (agent Steps) adds `kind: "agent"`. */
export type TurnSpec = ShellTurnSpec;

export interface TurnResult {
  /** Combined stdout the command produced. */
  stdout: string;
  /** The shell command's exit code — 0 is success, anything else is a failed turn. */
  exitCode: number;
  /** Host-side worktree path the named branch was checked out in. */
  worktreePath: string;
  /**
   * Non-null exactly when teardown preserved the worktree because it had
   * uncommitted changes — the signal the executor commits there. Null when
   * the worktree was clean (and removed), meaning there is nothing to commit.
   */
  preservedWorktreePath: string | null;
}

export interface Turn {
  /** Resolves once the turn ends, one way or another. Never rejects for a failing command — that is data inside `TurnResult`; it rejects only for a seam-level fault. */
  done: Promise<TurnResult>;
  /** Best-effort stop, built outside sandcastle (spec: "Cancel dibangun di luar sandcastle"). Docker mode: stops every container on the StepRun's network with a 30s grace. Host mode: SIGTERM to the command's process group. */
  cancel(): void;
}

/** The docker CLI primitives the seam needs for the per-StepRun-network cancel boundary. */
export interface DockerControl {
  /** `docker network create <name>` — must exist before the docker provider attaches. */
  createNetwork(name: string): Promise<void>;
  /** `docker network rm <name>` — best-effort teardown. */
  removeNetwork(name: string): Promise<void>;
  /** `docker ps -q --filter network=<name>` — every container on the StepRun's network. */
  containerIdsOnNetwork(name: string): Promise<string[]>;
  /** `docker stop --time <graceSeconds> <ids...>` — the 30-second grace cancel. */
  stop(ids: string[], graceSeconds: number): Promise<void>;
}

/** Spawns a shell in its own process group and can kill that group — the host-mode cancel primitive. */
export interface HostProcessControl {
  spawnShell(
    command: string,
    cwd: string,
    options: { env: Record<string, string>; onLine?: (line: string) => void },
  ): { pgid: number; result: Promise<{ stdout: string; stderr: string; exitCode: number }> };
  /** SIGTERM to the whole process group — children die with the parent (AC6). */
  killGroup(pgid: number): void;
}

/** Every host primitive a real turn needs, injectable for tests. */
export interface TurnRuntimeDeps {
  createSandbox: (options: CreateSandboxOptions) => Promise<Sandbox>;
  docker: DockerControl;
  hostProcess: HostProcessControl;
}
