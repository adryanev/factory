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
 *
 * Issue #9 adds the `kind: "agent"` turn: the real coding agent runs inside
 * the sandbox via sandcastle's own `run()` with the compiled Output union as
 * `Output.object` — the single `<factory-output>` tag is extracted and
 * validated with the one shared schema, self-correction runs through
 * `maxRetries` (derived from capabilities, AC8), and a rejected Output
 * surfaces as `OutputInvalidError`, never a seam fault.
 *
 * Issue #22 makes `exec:docker` egress enforced by default: the per-StepRun
 * network goes `--internal` and an allowlist-enforcing sidecar proxy (the
 * runner's own `egress-proxy` subcommand, mounted into a pinned Node image)
 * is the step container's only path off it. `--allow-unenforced-docker-egress`
 * is the explicit operator opt-out that restores the old unprotected shape.
 */
import { claudeCode, codex, createSandbox, cursor, type AgentProvider } from "@ai-hero/sandcastle";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDockerControl } from "./docker-control.js";
import { createDockerEgressControl } from "./egress-docker.js";
import { createHostProcessControl } from "./host-process.js";
import { createPfEgressControl } from "./egress.js";
import { createTurnRuntime } from "./runtime.js";
import type {
  AgentTurnSpec,
  DockerControl,
  HostProcessControl,
  RunsOn,
  ShellTurnSpec,
  Turn,
  TurnResult,
  TurnRuntimeDeps,
  TurnSpec,
} from "./types.js";

export type { RunsOn, ShellTurnSpec, AgentTurnSpec, Turn, TurnResult, TurnRuntimeDeps, DockerControl, HostProcessControl };
export type { TurnSpec };
export type { EgressControl } from "./egress.js";
export type { DockerEgressControl, DeploySidecarOptions } from "./egress-docker.js";
export {
  DOCKER_STOP_GRACE_SECONDS,
  OutputInvalidError,
  TurnCancelledError,
  shellEnvPrefix,
} from "./runtime.js";
export { createFactoryHostProvider } from "./host-provider.js";
export { createDockerControl } from "./docker-control.js";
export { createDockerEgressControl } from "./egress-docker.js";
export { createHostProcessControl } from "./host-process.js";
export { createTurnRuntime } from "./runtime.js";
export { renderEgressRules, createPfEgressControl } from "./egress.js";
export { matchAllowlist, normalizeHost, createEgressProxyServer, runEgressProxy } from "./egress-proxy.js";

/**
 * The model each agent CLI runs with. Model selection is genuinely a Runner
 * operator concern (spec names no model), so this is a single tunable spot —
 * the seam stays sandcastle-only; which model is chosen is not part of issue
 * 9's contract.
 */
const AGENT_MODELS: Record<string, string> = {
  claude: "claude-sonnet-4-6",
  codex: "gpt-5.4",
  "cursor-agent": "default",
};

/** The production map from agent CLI name to sandcastle's own provider (issue 9's agent turns). */
function defaultAgentProviderFor(name: string): AgentProvider {
  switch (name) {
    case "claude":
      return claudeCode(AGENT_MODELS["claude"]!, { captureSessions: true });
    case "codex":
      return codex(AGENT_MODELS["codex"]!);
    case "cursor-agent":
      return cursor(AGENT_MODELS["cursor-agent"]!);
    default:
      throw new Error(`no agent provider for '${name}' — known: claude, codex, cursor-agent`);
  }
}

/**
 * The runner's own entry — the file the egress sidecar mounts and runs as
 * `node main.js egress-proxy …` (issue #22). Two layouts exist: the tsc
 * build (`dist/main.js` beside `dist/agent-runtime/`) and the release
 * bundle (`main.js` beside nothing else). Resolving the first candidate that
 * exists keeps both working; a missing entry is a packaging fault surfaced
 * at deploy time with a clear message, never a silently unenforced turn.
 */
function resolveRunnerEntry(): string {
  const dir = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(dir, "main.js"), join(dir, "..", "main.js")]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `cannot locate the runner entry (main.js) next to ${dir} — ` +
      "the egress sidecar deploys by mounting the runner's own bundle. " +
      "Run `pnpm --filter @factory/runner build` once, or set FACTORY_EGRESS_PROXY_ENTRY to its path",
  );
}

/** The real system deps every production turn runs on. */
export function createSystemTurnRuntimeDeps(overrides?: {
  hostAgentUser?: string;
  allowUnenforcedDockerEgress?: boolean;
}): TurnRuntimeDeps {
  // The daemon passes the user recorded in the identity file at join; the env
  // var stays for a hand-run Runner that never joined through the installer.
  const hostAgentUser = overrides?.hostAgentUser ?? process.env["FACTORY_AGENT_USER"];
  const runnerEntry =
    process.env["FACTORY_EGRESS_PROXY_ENTRY"] ?? resolveRunnerEntry();
  return {
    createSandbox,
    docker: createDockerControl(),
    hostProcess: createHostProcessControl(),
    // AC7: the OS user `exec:host` drops the agent to. When unset, host-mode
    // turns run as the Runner's own user (weaker, but explicit in SECURITY.md).
    ...(hostAgentUser === undefined ? {} : { hostAgentUser }),
    // AC6: default-deny egress enforcement for the agent user (pf on macOS).
    egress: createPfEgressControl(),
    // Issue #22: `exec:docker` egress enforcement is the default; the flag
    // is the operator's explicit opt-out back to the unprotected shape.
    allowUnenforcedDockerEgress: overrides?.allowUnenforcedDockerEgress ?? false,
    dockerEgress: createDockerEgressControl({ runnerDir: dirname(runnerEntry) }),
    agentProviderFor: defaultAgentProviderFor,
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
