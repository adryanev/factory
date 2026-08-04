/**
 * The real turn implementation behind the seam. `startTurn(spec)` for a
 * `run:` Step:
 *
 *   1. creates the per-StepRun docker network (`docker` mode),
 *   2. asks sandcastle to create a worktree on the named branch (forked from
 *      the claimed base ref) and a sandbox around it — the **built-in** docker
 *      provider used as-is (`docker()`, spec: "Provider Docker bawaan
 *      sandcastle dipakai apa adanya") or our own host provider (tag
 *      "bind-mount", see `host-provider.ts`),
 *   3. runs the shell command, streaming lines out,
 *   4. closes the sandbox and reports the worktree path + whether teardown
 *      preserved it (uncommitted changes → the executor commits there).
 *
 * Cancel is built **outside** sandcastle (spec, verbatim): docker mode stops
 * every container on the StepRun's network with a 30-second grace; host mode
 * SIGTERMs the command's process group. Sandcastle's own idle/completion
 * timers are left untouched — the one wall-clock is the control plane's lease
 * (spec: "jam wall-clock hanya satu dan dipegang control plane").
 *
 * The token deliberately never appears in a spec (see `types.ts`): the sandbox
 * cannot pass `contents: write` if it never receives a token.
 *
 * Secrets (AC5) reach the agent call directly, never a file:
 *   - host mode: injected into the spawned process's environment;
 *   - docker mode: inlined as shell env assignments in the command
 *     (`FOO='...' BAR='...' sh -c 'command'`), which is visible in
 *     `docker inspect`/`ps` — a deliberately unprotected surface (see
 *     `docs/SECURITY.md`).
 *
 * AC7 (`exec:host`): the agent runs as `deps.hostAgentUser`, a separate OS
 * user from the Runner; AC6: default-deny egress rules for that user are
 * applied through `deps.egress` before the first spawn.
 */
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { createFactoryHostProvider } from "./host-provider.js";
import type { Turn, TurnResult, TurnRuntimeDeps, TurnSpec } from "./types.js";

/** "→ SIGTERM → tunggu 30 detik → SIGKILL" — docker's `--time` grace (spec: Cancel). */
export const DOCKER_STOP_GRACE_SECONDS = 30;

export class TurnCancelledError extends Error {
  constructor() {
    super("turn was cancelled");
    this.name = "TurnCancelledError";
  }
}

/** Single-quotes a value for `/bin/sh` assignment; the only escaping `sh` needs inside single quotes is the quote itself. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** `KEY='value' NEXT='other'` — the docker-mode secret transport (AC5). */
export function shellEnvPrefix(secrets: Record<string, string>): string {
  return Object.entries(secrets)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");
}

export function createTurnRuntime(deps: TurnRuntimeDeps) {
  return {
    startTurn(spec: TurnSpec): Turn {
      if (spec.kind !== "shell") {
        throw new Error(`unsupported turn kind: ${(spec as { kind: string }).kind}`);
      }

      let cancelled = false;
      let activePgid: number | null = null;

      const done = (async (): Promise<TurnResult> => {
        if (spec.runsOn === "docker") {
          await deps.docker.createNetwork(spec.network).catch(() => {
            // A pre-existing network (e.g. a re-claimed turn) is not an error;
            // any real failure surfaces when the container fails to attach.
          });
        }

        // The command that actually runs: in docker mode the secrets ride as
        // inline shell env assignments (no file is ever written); in host mode
        // they ride the spawned process's environment instead.
        const secretsPrefix = spec.runsOn === "docker" ? shellEnvPrefix(spec.secrets ?? {}) : "";
        const effectiveCommand = secretsPrefix ? `${secretsPrefix} ${spec.command}` : spec.command;

        const sandboxProvider =
          spec.runsOn === "docker"
            ? // The built-in provider, as-is — we never modify it (spec: AC1).
              docker({ imageName: spec.image, network: spec.network })
            : createFactoryHostProvider({
                hostProcess: deps.hostProcess,
                onSpawn: (pgid) => {
                  activePgid = pgid;
                },
                shouldSkip: () => cancelled,
                ...(spec.secrets === undefined ? {} : { env: spec.secrets }),
                ...(deps.hostAgentUser === undefined ? {} : { runAsUser: deps.hostAgentUser }),
                ...(deps.egress === undefined ? {} : { egress: deps.egress }),
                ...(spec.egressAllowlist === undefined ? {} : { egressAllowlist: spec.egressAllowlist }),
              });

        const sandbox = await deps.createSandbox({
          branch: spec.branch,
          baseBranch: spec.baseRef,
          sandbox: sandboxProvider,
          cwd: spec.workingDirectory,
        });

        try {
          const execResult = await sandbox.exec(
            effectiveCommand,
            spec.onLine ? { onLine: spec.onLine } : undefined,
          );
          if (cancelled) {
            throw new TurnCancelledError();
          }
          const closeResult = (await sandbox.close()) ?? {};
          return {
            stdout: execResult.stdout,
            exitCode: execResult.exitCode,
            worktreePath: sandbox.worktreePath,
            preservedWorktreePath: closeResult.preservedWorktreePath ?? null,
          };
        } catch (error) {
          await sandbox.close().catch(() => {});
          if (cancelled) {
            throw new TurnCancelledError();
          }
          throw error;
        } finally {
          if (spec.runsOn === "docker") {
            await deps.docker.removeNetwork(spec.network).catch(() => {});
          }
        }
      })();

      return {
        done,
        cancel(): void {
          if (cancelled) return;
          cancelled = true;
          if (spec.runsOn === "docker") {
            void deps.docker
              .containerIdsOnNetwork(spec.network)
              .then((ids) => deps.docker.stop(ids, DOCKER_STOP_GRACE_SECONDS))
              .catch(() => {});
          } else if (activePgid !== null) {
            deps.hostProcess.killGroup(activePgid);
          }
        },
      };
    },
  };
}
