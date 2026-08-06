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
import { Output, StructuredOutputError, run } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { FACTORY_OUTPUT_TAG } from "@factory/shared";
import { createFactoryHostProvider } from "./host-provider.js";
import type { AgentTurnSpec, Turn, TurnResult, TurnRuntimeDeps, TurnSpec } from "./types.js";

/** "→ SIGTERM → tunggu 30 detik → SIGKILL" — docker's `--time` grace (spec: Cancel). */
export const DOCKER_STOP_GRACE_SECONDS = 30;

export class TurnCancelledError extends Error {
  constructor() {
    super("turn was cancelled");
    this.name = "TurnCancelledError";
  }
}

/**
 * Thrown by an agent turn when the agent's single `<factory-output>` tag
 * failed sandcastle's structured-output extraction or validation — after the
 * `maxRetries` resume attempts were exhausted (AC7). Distinct from
 * `TurnCancelledError` and from a seam fault: the executor turns it into
 * `failed` with `reason: output-invalid`, never into a turn fault.
 */
export class OutputInvalidError extends Error {
  constructor(cause: StructuredOutputError) {
    super(`output-invalid: ${cause.message}`);
    this.name = "OutputInvalidError";
    this.cause = cause;
  }
}

/**
 * Thrown when a turn asked for `exec:docker` on a Runner that has not been
 * told to accept unenforced egress. Docker mode applies no egress rule at all
 * — `egressAllowlist` reaches this file and is then only ever read by the host
 * provider — so running one silently would break the default-deny promise in
 * `docs/SECURITY.md`. Refusing is the fail-closed reading; the operator opts
 * back in per Runner. See `docs/adr/0005-sandbox-egress.md`.
 */
export class UnenforcedEgressError extends Error {
  constructor() {
    super(
      "exec:docker applies no egress rules: the sandbox joins an ordinary bridge network and can reach anything this host can. " +
        "Run the Step with `runs_on: [exec:host]`, or start the Runner with --allow-unenforced-docker-egress to accept that.",
    );
    this.name = "UnenforcedEgressError";
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
      // Both kinds of turn pass here, so the egress gate is checked once.
      if (spec.runsOn === "docker" && deps.allowUnenforcedDockerEgress !== true) {
        throw new UnenforcedEgressError();
      }
      if (spec.kind === "agent") {
        return startAgentTurn(deps, spec);
      }
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
          // The Join manifest (issue #11, AC7) rides into the worktree as a
          // well-known relative file so both shell and agent turns can read
          // it — the executor wrote it to the host repo root, and sandcastle
          // copies `copyToWorktree` paths into the worktree at creation.
          ...(spec.manifestFile ? { copyToWorktree: [".factory-manifest.json"] } : {}),
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

/**
 * An agent Step's turn: sandcastle's own `run()` with the compiled
 * discriminated union as `Output.object({ tag, schema, maxRetries })`. This
 * is where the single `<factory-output>` tag is extracted and validated with
 * the one shared schema, where the agent's self-correction happens
 * (`maxRetries` resume-and-feedback loops), and where `run()` "fails at
 * entry" if a retry was requested for a provider that cannot resume — which
 * the Runner avoids by deriving `maxRetries` from capabilities (AC8).
 *
 * The turn also streams the agent's raw stdout lines into the live-log sink
 * (`onLine`), reports the validated Output and the captured session so the
 * executor can classify `question` vs `done` and (later) resume, and throws
 * `OutputInvalidError` — not a seam fault — when the Output was rejected.
 */
function startAgentTurn(deps: TurnRuntimeDeps, spec: AgentTurnSpec): Turn {
  let cancelled = false;
  const abort = new AbortController();

  const done = (async (): Promise<TurnResult> => {
    if (spec.runsOn === "docker") {
      await deps.docker.createNetwork(spec.network).catch(() => {});
    }

    const sandboxProvider =
      spec.runsOn === "docker"
        ? docker({ imageName: spec.image, network: spec.network })
        : createFactoryHostProvider({
            hostProcess: deps.hostProcess,
            // Cancel for an agent turn goes through the AbortSignal sandcastle
            // wires to the agent subprocess; there is no single pgid to track.
            shouldSkip: () => cancelled,
            ...(spec.secrets === undefined ? {} : { env: spec.secrets }),
            ...(deps.hostAgentUser === undefined ? {} : { runAsUser: deps.hostAgentUser }),
            ...(deps.egress === undefined ? {} : { egress: deps.egress }),
            ...(spec.egressAllowlist === undefined ? {} : { egressAllowlist: spec.egressAllowlist }),
          });

    try {
      // A resumed turn resumes from a session that may never have been on this
      // machine (issue 13, AC1 — the Runner is interchangeable). The executor
      // downloaded the JSONL from the blob store; materialize it at the
      // provider's host session path so sandcastle's resume precheck and
      // `resumeIntoSandbox` find it, exactly where the provider would have
      // captured it.
      if (spec.resumeSession !== undefined && spec.resumeSessionContent !== undefined) {
        const provider = deps.agentProviderFor(spec.agent);
        const hostPath = provider.sessionStorage?.hostSessionFilePath(
          spec.workingDirectory,
          spec.resumeSession,
        );
        if (hostPath) {
          await mkdir(dirname(hostPath), { recursive: true });
          await writeFile(hostPath, spec.resumeSessionContent);
        }
      }

      const result = await run({
        agent: deps.agentProviderFor(spec.agent),
        sandbox: sandboxProvider,
        cwd: spec.workingDirectory,
        prompt: spec.prompt,
        maxIterations: 1,
        branchStrategy: { type: "branch", branch: spec.branch, baseBranch: spec.baseRef },
        output: Output.object({
          tag: FACTORY_OUTPUT_TAG,
          // `compileStepOutputContract` returns a Zod schema, which is a
          // Standard Schema — exactly what `Output.object` accepts.
          schema: spec.outputContract as Parameters<typeof Output.object>[0]["schema"],
          maxRetries: spec.maxRetries,
        }),
        ...(spec.resumeSession !== undefined ? { resumeSession: spec.resumeSession } : {}),
        signal: abort.signal,
        // The Join manifest (issue #11, AC7) is copied from the host repo
        // root into the worktree before the agent starts, as the well-known
        // relative file the final prompt names.
        ...(spec.manifestFile ? { copyToWorktree: [".factory-manifest.json"] } : {}),
        ...(spec.onLine
          ? {
              logging: {
                type: "file" as const,
                path: `${spec.workingDirectory}/.sandcastle/logs/${spec.branch}.log`,
                verbose: true,
                onAgentStreamEvent: (event: import("@ai-hero/sandcastle").AgentStreamEvent) => {
                  if (event.type === "raw") spec.onLine?.(event.line);
                },
              },
            }
          : {}),
      });
      if (cancelled) {
        throw new TurnCancelledError();
      }

      const lastIteration = result.iterations.at(-1);
      return {
        stdout: result.stdout,
        exitCode: 0,
        worktreePath: "",
        preservedWorktreePath: result.preservedWorktreePath ?? null,
        output: (result as { output?: unknown }).output,
        ...(lastIteration?.sessionId !== undefined ? { sessionId: lastIteration.sessionId } : {}),
        ...(lastIteration?.sessionFilePath !== undefined ? { sessionFilePath: lastIteration.sessionFilePath } : {}),
      };
    } catch (error) {
      if (cancelled) {
        throw new TurnCancelledError();
      }
      if (error instanceof StructuredOutputError) {
        throw new OutputInvalidError(error);
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
      abort.abort();
      if (spec.runsOn === "docker") {
        void deps.docker
          .containerIdsOnNetwork(spec.network)
          .then((ids) => deps.docker.stop(ids, DOCKER_STOP_GRACE_SECONDS))
          .catch(() => {});
      }
    },
  };
}
