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
  /**
   * The Project's secrets, resolved at `/claim` (AC5). Never written to a
   * file inside the sandbox: host mode injects them into the spawned
   * process's environment; docker mode inlines them as shell env
   * assignments in the command (visible in `docker inspect` — a deliberately
   * unprotected surface, see `docs/SECURITY.md`).
   */
  secrets?: Record<string, string>;
  /**
   * The Project's default-deny egress allowlist (AC6). The seam is expected
   * to deny everything not listed here.
   */
  egressAllowlist?: string[];
  /** Streamed stdout line sink (a future live-tail/log-chunks consumer). */
  onLine?: (line: string) => void;
  /**
   * Host path to this StepRun's Join manifest (issue #11, AC7) — the
   * upstream branches as `[{ key, repo, branch, sha, outcome, outputs }]`.
   * The seam copies it into the sandbox worktree as `.factory-manifest.json`
   * before the turn starts, so both shell and agent turns read it by that
   * relative name. Absent for a Step that joins nothing.
   */
  manifestFile?: string;
}

/**
 * An agent Step's turn (issue 9): the coding agent runs in the sandbox with
 * the *final* prompt — the Step's own prompt text plus the generated
 * format-instruction block (AC4: "Blok instruksi dibangkitkan Runner dari
 * `outputs:` dan ditempelkan ke prompt") — and emits exactly one
 * `<factory-output>` XML tag in its stdout. Everything the seam needs about
 * the Output contract is carried here: the compiled discriminated union
 * (the one schema, from `@factory/shared`), the system tag name, and the
 * `maxRetries` the Runner derived from the agent's capabilities (AC8) —
 * sandcastle's `run()` fails at entry when retries are requested for an
 * agent that cannot resume, so the derivation and the provider must agree.
 */
export interface AgentTurnSpec {
  kind: "agent";
  /** The final prompt to send — prompt file content plus the format-instruction block. */
  prompt: string;
  /** The coding agent CLI, one of the Runner's `KNOWN_AGENT_CLI_NAMES`. */
  agent: string;
  /**
   * The compiled discriminated union (`compileStepOutputContract`), passed
   * to sandcastle's `Output.object({ tag, schema, maxRetries })`. Typed as
   * `unknown` because the runner package must not import zod directly — it
   * reaches zod only through `@factory/shared`; the seam casts it to the
   * Standard Schema `Output.object` expects.
   */
  outputContract: unknown;
  /** Derived from agent capabilities (AC8): a resumable agent → 2, else 0. */
  maxRetries: number;
  /** Resume a prior agent session by id (a follow-up turn after the agent asked a human). */
  resumeSession?: string;
  /**
   * The resumed session's JSONL content, downloaded from the blob store by the
   * executor (issue 13, AC2). The seam materializes it at the provider's host
   * session path before the turn starts, so sandcastle's resume precheck and
   * `resumeIntoSandbox` find the session — the Runner is interchangeable, so
   * a turn may resume on a machine that never saw the original session.
   */
  resumeSessionContent?: string;
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
  /** The Project's secrets (AC5) — handed to the agent call, never a file. */
  secrets?: Record<string, string>;
  /** The Project's default-deny egress allowlist (AC6). */
  egressAllowlist?: string[];
  /** Streamed stdout line sink (the live-log chunk source). */
  onLine?: (line: string) => void;
  /**
   * Host path to this StepRun's Join manifest (issue #11, AC7) — copied into
   * the sandbox worktree as `.factory-manifest.json` before the turn starts;
   * the final prompt names it for the agent. Absent for a Step that joins
   * nothing.
   */
  manifestFile?: string;
}

/**
 * The seam grows by discriminated union — issue 9 (agent Steps) adds
 * `kind: "agent"` alongside the issue 6 `kind: "shell"`.
 */
export type TurnSpec = ShellTurnSpec | AgentTurnSpec;

export interface TurnResult {
  /** Combined stdout the command produced. For an agent turn this is the raw agent stdout, including the single `<factory-output>` tag. */
  stdout: string;
  /** The shell command's exit code — 0 is success, anything else is a failed turn. Always 0 for a resolving agent turn (sandcastle's `run()` throws rather than return a non-zero exit). */
  exitCode: number;
  /** Host-side worktree path the named branch was checked out in. Empty for agent turns — sandcastle's `run()` manages its own worktree. */
  worktreePath: string;
  /**
   * Non-null exactly when teardown preserved the worktree because it had
   * uncommitted changes — the signal the executor commits there. Null when
   * the worktree was clean (and removed), meaning there is nothing to commit.
   */
  preservedWorktreePath: string | null;
  /**
   * The turn's structured Output, when the seam already extracted and
   * validated it (agent turns run through sandcastle's `Output.object` with
   * the one shared schema, so this is already conformant). Absent for shell
   * turns and for agent turns whose Output was rejected — the executor
   * falls back to parsing the tag from `stdout`, and a rejected Output
   * surfaces as `OutputInvalidError` instead.
   */
  output?: unknown;
  /** The agent session id captured by the turn, when available. */
  sessionId?: string;
  /** Host path to the captured session JSONL, when available. */
  sessionFilePath?: string;
}

export interface Turn {
  /** Resolves once the turn ends, one way or another. Never rejects for a failing command — that is data inside `TurnResult`; it rejects only for a seam-level fault. */
  done: Promise<TurnResult>;
  /** Best-effort stop, built outside sandcastle (spec: "Cancel dibangun di luar sandcastle"). Docker mode: stops every container on the StepRun's network with a 30s grace. Host mode: SIGTERM to the command's process group. */
  cancel(): void;
}

/** The docker CLI primitives the seam needs for the per-StepRun-network cancel boundary and egress enforcement (issue #22). */
export interface DockerControl {
  /**
   * `docker network create [--internal] <name>` — must exist before the
   * docker provider attaches. `internal: true` is the egress boundary: the
   * step container then has no route to anything outside the network (issue
   * #22); the sidecar is its only path off it.
   */
  createNetwork(name: string, options?: { internal?: boolean }): Promise<void>;
  /** `docker network rm <name>` — best-effort teardown. */
  removeNetwork(name: string): Promise<void>;
  /**
   * `docker network inspect <name> --format {{.Internal}}` — true when the
   * network is `--internal`. The fail-closed check for a re-claimed turn
   * whose network already exists: a pre-existing network that is not
   * internal means the turn must not run (issue #22).
   */
  networkInternal(name: string): Promise<boolean>;
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
    options: {
      env: Record<string, string>;
      /** When set, the command runs as this OS user via `sudo -n -u <user> --` (AC7: agent as a separate OS user). */
      runAsUser?: string;
      onLine?: (line: string) => void;
    },
  ): { pgid: number; result: Promise<{ stdout: string; stderr: string; exitCode: number }> };
  /** SIGTERM to the whole process group — children die with the parent (AC6). */
  killGroup(pgid: number): void;
}

/** Every host primitive a real turn needs, injectable for tests. */
export interface TurnRuntimeDeps {
  createSandbox: (options: CreateSandboxOptions) => Promise<Sandbox>;
  docker: DockerControl;
  hostProcess: HostProcessControl;
  /** The OS user `exec:host` runs the agent as (AC7) — separate from the Runner's own user. */
  hostAgentUser?: string;
  /** Egress enforcement (AC6) — when present, `exec:host` installs default-deny allowlist rules for the agent user. */
  egress?: import("./egress.js").EgressControl;
  /**
   * Turns `exec:docker` egress enforcement **off** for this Runner (issue
   * #22). Off by default, and default-deny holds in that default: every
   * docker turn runs on an internal per-StepRun network with an
   * allowlist-enforcing sidecar proxy as its only path off the network. An
   * operator who sets this opts back into the pre-enforcement behavior — the
   * sandbox joins an ordinary bridge network and reaches whatever the host
   * reaches. See `docs/adr/0005-sandbox-egress.md`.
   */
  allowUnenforcedDockerEgress?: boolean;
  /**
   * The docker egress enforcement seam (issue #22): deploys the
   * allowlist-enforcing sidecar proxy on the StepRun's networks before the
   * step container starts, and removes it at teardown. Required, so a deps
   * set without it cannot silently run docker turns unenforced.
   */
  dockerEgress: import("./egress-docker.js").DockerEgressControl;
  /**
   * Builds the sandcastle `AgentProvider` for an agent CLI name (issue 9's
   * agent turns). Injectable so tests can substitute a provider without
   * dialing a real agent CLI; the production default maps the known CLIs to
   * sandcastle's own providers.
   */
  agentProviderFor: (name: string) => import("@ai-hero/sandcastle").AgentProvider;
}
