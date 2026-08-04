/**
 * The real host-mode process primitive: spawn a shell command in its own
 * process group (`detached: true` makes the child the group leader), stream
 * stdout line-by-line to `onLine`, and kill the whole group on cancel — the
 * test the acceptance criterion demands is "proses anak ikut mati".
 *
 * AC7 — the agent runs as a *separate OS user* from the Runner: when
 * `runAsUser` is set, the command is spawned through `sudo -n -u <user> --`
 * so the child process carries the agent user's identity. The Runner's own
 * secret files (`identity.ts`, mode `0o600`) are unreadable to that user —
 * POSIX gives no other user access to a 0600 file — which is exactly the
 * "user itu tidak bisa membaca file secret Runner" the criterion demands.
 * The argv shape is factored into `buildShellSpawnArgs` so a test can pin it
 * without spawning anything.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { HostProcessControl } from "./types.js";

export interface ShellSpawnOptions {
  env: Record<string, string>;
  runAsUser?: string;
  onLine?: (line: string) => void;
}

/**
 * The argv for a host-mode shell command. With `runAsUser`, `sudo -n` (no
 * password prompt — a background agent turn cannot hang on one) drops the
 * shell to that user; without it, the shell runs as the Runner's own user.
 */
export function buildShellSpawnArgs(command: string, runAsUser: string | undefined): string[] {
  const shellArgs = ["-c", command];
  return runAsUser ? ["-n", "-u", runAsUser, "--", "/bin/sh", ...shellArgs] : ["/bin/sh", ...shellArgs];
}

export function createHostProcessControl(): HostProcessControl {
  return {
    spawnShell(command, cwd, options) {
      const args = buildShellSpawnArgs(command, options.runAsUser);
      // `sudo` is the only binary we ever spawn under a different user; the
      // plain path spawns the shell directly.
      const file = options.runAsUser ? "sudo" : args[0]!;
      const child = spawn(file, options.runAsUser ? args : args.slice(1), {
        cwd,
        env: options.env,
        // A new process group: the child is the group leader, so its own
        // children join the same group and `kill(-pgid)` takes them all down.
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const pgid = child.pid ?? 0;

      let stdout = "";
      let stderr = "";
      if (child.stdout) {
        const lines = createInterface({ input: child.stdout });
        lines.on("line", (line) => {
          stdout += `${line}\n`;
          options.onLine?.(line);
        });
      }
      if (child.stderr) {
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf-8");
        });
      }

      const result = new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
        child.on("error", (error) => reject(error));
        child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? -1 }));
      });

      return { pgid, result };
    },
    killGroup(pgid) {
      if (pgid <= 0) return;
      try {
        process.kill(-pgid, "SIGTERM");
      } catch {
        // The group may already be gone — best-effort is the whole contract.
      }
    },
  };
}
