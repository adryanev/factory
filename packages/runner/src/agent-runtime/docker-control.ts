/**
 * The real docker CLI control — the per-StepRun-network cancel boundary
 * (spec: "docker lewat network per-StepRun → stop dengan grace 30 detik").
 * All three operations shell out to the `docker` CLI; tests inject a fake so
 * the cancel path is provable without a daemon.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DockerControl } from "./types.js";

const execFileAsync = promisify(execFile);

export function createDockerControl(): DockerControl {
  return {
    async createNetwork(name) {
      await execFileAsync("docker", ["network", "create", name]);
    },
    async removeNetwork(name) {
      await execFileAsync("docker", ["network", "rm", name]);
    },
    async containerIdsOnNetwork(name) {
      const { stdout } = await execFileAsync("docker", ["ps", "-q", "--filter", `network=${name}`]);
      return stdout.trim().split("\n").filter((line) => line.length > 0);
    },
    async stop(ids, graceSeconds) {
      if (ids.length === 0) return;
      await execFileAsync("docker", ["stop", "--time", String(graceSeconds), ...ids]);
    },
  };
}
