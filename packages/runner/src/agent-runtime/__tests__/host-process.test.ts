/**
 * AC6's host half, against the real process primitive: "host lewat sinyal ke
 * process group; test membuktikan proses anak ikut mati." A shell spawns a
 * background child; killing the process group must take the child down too,
 * not just the shell.
 */
import { describe, expect, it } from "vitest";
import { createHostProcessControl } from "../host-process.js";

const WAIT_MS = 150;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
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
});
