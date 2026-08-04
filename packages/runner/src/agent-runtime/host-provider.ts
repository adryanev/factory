/**
 * The custom **host** provider (spec: "Provider host **ditulis sendiri** dan
 * didaftarkan dengan tag bind-mount"). It runs the command directly on the
 * Runner's machine — no container — but is registered via sandcastle's
 * `createBindMountSandboxProvider`, which tags it `"bind-mount"`. That tag is
 * the session-capture gate: `"bind-mount"` providers participate in session
 * capture, while `tag: "none"` (sandcastle's built-in `noSandbox()`) silently
 * disables it — which is exactly why we write our own rather than use the
 * built-in, so interactive Steps (issue 9) keep working on a macOS host
 * (spec: "tanpa itu step interaktif patah tanpa suara di Runner macOS").
 *
 * `exec` streams stdout line-by-line (the provider contract), and spawns in a
 * process group so `cancel()` can kill the whole group — see `host-process.ts`.
 */
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createBindMountSandboxProvider } from "@ai-hero/sandcastle";
import type { EgressControl } from "./egress.js";
import type { HostProcessControl } from "./types.js";

export interface FactoryHostProviderOptions {
  hostProcess: HostProcessControl;
  /** Invoked with the process-group id of the currently-running command — the hook `cancel()` reads. */
  onSpawn?: (pgid: number) => void;
  /** When true, `exec` resolves immediately without spawning — used when `cancel()` landed before the command started. */
  shouldSkip?: () => boolean;
  /** Extra env for every command — the Project's secrets (never a git token — see `types.ts`). */
  env?: Record<string, string>;
  /** AC7: the OS user the agent runs as, separate from the Runner's own user. */
  runAsUser?: string;
  /** AC6: egress enforcement — when set alongside `runAsUser`, default-deny allowlist rules are applied for the agent user. */
  egress?: EgressControl;
  /** AC6: the allowlist to apply. */
  egressAllowlist?: string[];
}

export function createFactoryHostProvider(options: FactoryHostProviderOptions) {
  const { hostProcess, onSpawn, shouldSkip, env, runAsUser, egress, egressAllowlist } = options;
  const home = process.env["HOME"];
  return createBindMountSandboxProvider({
    name: "factory-host",
    ...(home ? { sandboxHomedir: home } : {}),
    create: async ({ worktreePath, env: createEnv }) => {
      const mergedEnv: Record<string, string> = { ...env, ...createEnv };
      for (const key of Object.keys(process.env)) {
        const value = process.env[key];
        if (value !== undefined && !(key in mergedEnv)) {
          mergedEnv[key] = value;
        }
      }
      // AC6: default-deny egress for the agent user, before the first spawn.
      let egressHandle: string | undefined;
      if (runAsUser && egress) {
        egressHandle = await egress.apply(runAsUser, egressAllowlist ?? []);
      }
      return {
        worktreePath,
        async exec(command, execOptions) {
          if (shouldSkip?.()) {
            return { stdout: "", stderr: "", exitCode: -1 };
          }
          const spawnOptions: {
            env: Record<string, string>;
            runAsUser?: string;
            onLine?: (line: string) => void;
          } = { env: mergedEnv };
          if (runAsUser !== undefined) spawnOptions.runAsUser = runAsUser;
          if (execOptions?.onLine !== undefined) spawnOptions.onLine = execOptions.onLine;
          const spawned = hostProcess.spawnShell(command, execOptions?.cwd ?? worktreePath, spawnOptions);
          onSpawn?.(spawned.pgid);
          return spawned.result;
        },
        async copyFileIn(hostPath, sandboxPath) {
          const destination = path.join(worktreePath, sandboxPath);
          await mkdir(path.dirname(destination), { recursive: true });
          await copyFile(hostPath, destination);
        },
        async copyFileOut(sandboxPath, hostPath) {
          await copyFile(path.join(worktreePath, sandboxPath), hostPath);
        },
        async close() {
          // No container to tear down — the worktree lifecycle is sandcastle's.
          // Tear down the egress anchor (best-effort, like every teardown).
          if (egressHandle !== undefined) {
            await egress?.remove(egressHandle).catch(() => {});
          }
        },
      };
    },
  });
}
