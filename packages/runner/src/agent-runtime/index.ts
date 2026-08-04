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
import { createPfEgressControl, type EgressControl } from "./egress.js";
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
export type { EgressControl } from "./egress.js";
export { DOCKER_STOP_GRACE_SECONDS, TurnCancelledError, shellEnvPrefix } from "./runtime.js";
export { createFactoryHostProvider } from "./host-provider.js";
export { createDockerControl } from "./docker-control.js";
export { createHostProcessControl } from "./host-process.js";
export { createTurnRuntime } from "./runtime.js";
export { renderEgressRules, createPfEgressControl } from "./egress.js";

/** The real system deps every production turn runs on. */
export function createSystemTurnRuntimeDeps(): TurnRuntimeDeps {
  const hostAgentUser = process.env["FACTORY_AGENT_USER"];
  return {
    createSandbox,
    docker: createDockerControl(),
    hostProcess: createHostProcessControl(),
    // AC7: the OS user `exec:host` drops the agent to. When unset, host-mode
    // turns run as the Runner's own user (weaker, but explicit in SECURITY.md).
    ...(hostAgentUser === undefined ? {} : { hostAgentUser }),
    // AC6: default-deny egress enforcement for the agent user (pf on macOS).
    egress: createPfEgressControl(),
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
