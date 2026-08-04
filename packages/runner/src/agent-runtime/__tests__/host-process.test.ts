/**
 * AC6's host half, against the real process primitive: "host lewat sinyal ke
 * process group; test membuktikan proses anak ikut mati." A shell spawns a
 * background child; killing the process group must take the child down too,
 * not just the shell.
 *
 * AC7's host half lives here too: the agent runs as a *separate OS user*
 * (`runAsUser` → `sudo -n -u <user> --`), and a test proves that user cannot
 * read the Runner's secret file (mode 0600). The cross-user proof needs
 * passwordless sudo, so it is gated on `sudo -n true` succeeding.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { buildShellSpawnArgs, createHostProcessControl } from "../host-process.js";

const execFileAsync = promisify(execFile);
const WAIT_MS = 150;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function passwordlessSudoAvailable(): Promise<boolean> {
  try {
    await execFileAsync("sudo", ["-n", "true"]);
    return true;
  } catch {
    return false;
  }
}

describe("host process group control", () => {
  it("killGroup terminates the whole group — a backgrounded child dies with its parent", async () => {
    const control = createHostProcessControl();

    // The shell backgrounds `sleep 60` (stdout redirected so it cannot hold
    // the pipe open) and prints its pid, then the shell itself exits — the
    // child keeps running in the same process group.
    const spawned = control.spawnShell("sleep 60 > /dev/null 2>&1 & echo $!", "/tmp", {
      env: process.env as Record<string, string>,
    });
    const { stdout } = await spawned.result;
    const childPid = Number(stdout.trim());
    expect(Number.isInteger(childPid)).toBe(true);
    expect(alive(childPid)).toBe(true);

    control.killGroup(spawned.pgid);
    await new Promise((resolve) => setTimeout(resolve, WAIT_MS));

    expect(alive(childPid)).toBe(false); // the child died with the group.
  });

  it("the spawned shell runs in its own process group, not the test runner's", async () => {
    const control = createHostProcessControl();
    const spawned = control.spawnShell("sleep 30", "/tmp", { env: process.env as Record<string, string> });
    // detached:true makes the shell a group leader of a *new* group whose id
    // is its own fresh pid — never the test runner's — so a cancel here can
    // never take down the suite.
    expect(spawned.pgid).toBeGreaterThan(0);
    expect(spawned.pgid).not.toBe(process.pid);
    control.killGroup(spawned.pgid);
    await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
  });

  it("AC7 — runAsUser builds the sudo argv that drops the shell to another OS user", () => {
    expect(buildShellSpawnArgs("echo hi", "factoryjob")).toEqual([
      "-n",
      "-u",
      "factoryjob",
      "--",
      "/bin/sh",
      "-c",
      "echo hi",
    ]);
    // Without runAsUser the shell runs as the Runner's own user — no sudo.
    expect(buildShellSpawnArgs("echo hi", undefined)).toEqual(["/bin/sh", "-c", "echo hi"]);
  });
});

describe("AC7: the agent OS user cannot read the Runner's secret files", () => {
  it(
    "a 0600 secret file is unreadable to a different OS user and readable to its owner",
    { retry: 0 },
    async () => {
      // Cross-user proof needs passwordless sudo; on hosts without it the
      // structural guarantees are still covered by buildShellSpawnArgs and the
      // mode-0600 write path (identity.ts), so this test skips itself.
      if (!(await passwordlessSudoAvailable())) {
        return;
      }
      const dir = await mkdtemp(path.join(os.tmpdir(), "runner-secret-ac7-"));
      try {
        const secretFile = path.join(dir, "runner.secret");
        await writeFile(secretFile, "runner-bearer-secret", { mode: 0o600 });

        const control = createHostProcessControl();
        // As `nobody` (a real, distinct OS user on macOS/Linux): must not read it.
        const asAgent = control.spawnShell(`cat ${secretFile} 2>/dev/null || echo BLOCKED`, dir, {
          env: process.env as Record<string, string>,
          runAsUser: "nobody",
        });
        const agentResult = await asAgent.result;
        expect(agentResult.stdout).toContain("BLOCKED");
        expect(agentResult.stdout).not.toContain("runner-bearer-secret");

        // As the Runner's own user: must read it.
        const asRunner = control.spawnShell(`cat ${secretFile}`, dir, {
          env: process.env as Record<string, string>,
        });
        const runnerResult = await asRunner.result;
        expect(runnerResult.exitCode).toBe(0);
        expect(runnerResult.stdout).toContain("runner-bearer-secret");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
