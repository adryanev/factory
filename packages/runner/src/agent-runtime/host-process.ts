/**
 * The real host-mode process primitive: spawn a shell command in its own
 * process group (`detached: true` makes the child the group leader), stream
 * stdout line-by-line to `onLine`, and kill the whole group on cancel — the
 * test the acceptance criterion demands is "proses anak ikut mati".
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { HostProcessControl } from "./types.js";

export function createHostProcessControl(): HostProcessControl {
  return {
    spawnShell(command, cwd, options) {
      const child = spawn("/bin/sh", ["-c", command], {
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
