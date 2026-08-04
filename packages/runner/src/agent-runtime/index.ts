/**
 * The one seam sandcastle may be imported through — "seluruh pemakaiannya
 * diisolasi di satu direktori agent-runtime yang jadi satu-satunya importir,
 * mengekspor satu fungsi `startTurn(spec) -> { done, cancel() }`" (spec,
 * verbatim). Nothing outside `agent-runtime/` imports sandcastle; the version
 * is pinned exactly in `package.json`.
 *
 * Issue #6 makes this seam real for `run:` Steps (shell commands). The fake
 * it used to be is gone: `startTurn` now creates a real sandbox (docker or
 * host), runs the command, and reports the exit code + the worktree it left
 * behind — see `runtime.ts` for the lifecycle and `types.ts` for why the
 * spec carries no git token and no wall-clock.
 */
import { createSandbox } from "@ai-hero/sandcastle";
import { createDockerControl } from "./docker-control.js";
import { createHostProcessControl } from "./host-process.js";
import { createTurnRuntime } from "./runtime.js";
import type {
  DockerControl,
  HostProcessControl,
  RunsOn,
  ShellTurnSpec,
  Turn,
  TurnResult,
  TurnRuntimeDeps,
  TurnSpec,
} from "./types.js";

export type { RunsOn, ShellTurnSpec, Turn, TurnResult, TurnRuntimeDeps, DockerControl, HostProcessControl };
export type { TurnSpec };
export { DOCKER_STOP_GRACE_SECONDS, TurnCancelledError } from "./runtime.js";
export { createFactoryHostProvider } from "./host-provider.js";
export { createDockerControl } from "./docker-control.js";
export { createHostProcessControl } from "./host-process.js";
export { createTurnRuntime } from "./runtime.js";

/** The real system deps every production turn runs on. */
export function createSystemTurnRuntimeDeps(): TurnRuntimeDeps {
  return {
    createSandbox,
    docker: createDockerControl(),
    hostProcess: createHostProcessControl(),
  };
}

/**
 * The seam's public face: `startTurn(spec) -> { done, cancel() }`. For a
 * `run:` Step this creates a sandbox, runs the shell command, and resolves
 * with the exit code and worktree path. See `runtime.ts`.
 */
export function startTurn(spec: TurnSpec): Turn {
  return createTurnRuntime(createSystemTurnRuntimeDeps()).startTurn(spec);
}
