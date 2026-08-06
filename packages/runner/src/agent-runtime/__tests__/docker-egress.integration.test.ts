/**
 * Issue #22's proof at the real seam: a genuine `exec:docker` turn against a
 * real docker daemon, with the real runner bundle running as the egress
 * sidecar. From inside the step container it asserts:
 *
 *  - an allowlisted host IS reachable through the proxy (HTTP and HTTPS/CONNECT);
 *  - a host outside the allowlist is NOT reachable through the proxy;
 *  - there is NO route around the proxy — a direct, proxy-off attempt to the
 *    allowlisted host fails, because the per-StepRun network is `--internal`.
 *
 * The only fakes are none: the turn runs through `createTurnRuntime` with
 * real sandcastle, real docker control, and a bundle of the real runner
 * (`src/main.ts` via esbuild — the same shape as the release tarball) mounted
 * into the sidecar container. The test skips itself when no docker daemon is
 * reachable (CI without docker gets the unit-level proofs in
 * `runtime.test.ts` and `egress-proxy.test.ts` instead).
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { createTurnRuntime } from "../runtime.js";
import { createDockerControl } from "../docker-control.js";
import { createDockerEgressControl } from "../egress-docker.js";
import { createHostProcessControl } from "../host-process.js";
import type { TurnRuntimeDeps } from "../types.js";

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../../../../", import.meta.url)));
const SIDECAR_IMAGE = "node:24.18.0-alpine"; // locally available; the proxy needs only node

const dockerAvailable = await (async (): Promise<boolean> => {
  try {
    await execFileAsync("docker", ["info"]);
    return true;
  } catch {
    return false;
  }
})();

async function makeTempGitRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "factory-docker-egress-"));
  await execFileAsync("git", ["init", "-q", "-b", "main", dir]);
  await writeFile(path.join(dir, "a.txt"), "a\n");
  await execFileAsync("git", ["-C", dir, "add", "-A"]);
  await execFileAsync("git", ["-C", dir, "-c", "user.name=itest", "-c", "user.email=itest@factory", "commit", "-q", "-m", "init"]);
  return dir;
}

/**
 * The step image: the sandcastle docker provider starts the container with
 * no command and `docker exec`s into it, so the image needs a persistent
 * default CMD (plain alpine/node images exit immediately — "cannot exec in a
 * stopped container"). Built at test time so the integration test needs no
 * extra pull: a tiny alpine with busybox wget and `sleep infinity`.
 */
async function buildStepImage(tag: string): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "factory-step-image-"));
  cleanupDirs.push(dir);
  await writeFile(path.join(dir, "Dockerfile"), `FROM ${SIDECAR_IMAGE}\nCMD ["sleep", "infinity"]\n`);
  await execFileAsync("docker", ["build", "-q", "-t", tag, dir]);
}

/** Bundles the real runner entry — the same esbuild shape the release tarball ships (banner included: yaml's dynamic require). */
async function bundleRunner(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "factory-runner-bundle-"));
  await build({
    entryPoints: [path.join(REPO_ROOT, "packages/runner/src/main.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    banner: {
      js: "#!/usr/bin/env node\nimport { createRequire as __factoryCreateRequire } from 'node:module'; const require = __factoryCreateRequire(import.meta.url);",
    },
    outfile: path.join(dir, "main.js"),
    logLevel: "warning",
  });
  return dir;
}

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** The probes run inside the step container; busybox wget honors the proxy env (HTTP + CONNECT). */
function probeCommand(): string {
  return [
    `A=$(wget -qO- -T 10 http://example.com/ 2>&1 | head -c 200)`,
    `B=$(wget -qO- -T 10 https://example.com/ 2>&1 | head -c 200)`,
    `wget -qO- -T 10 http://registry.npmjs.org/ >/dev/null 2>&1 && C=UNEXPECTED-SUCCESS || C=blocked`,
    `wget -qO- -T 10 https://registry.npmjs.org/ >/dev/null 2>&1 && D=UNEXPECTED-SUCCESS || D=blocked`,
    `wget -Y off -qO- -T 6 http://example.com/ >/dev/null 2>&1 && E=UNEXPECTED-SUCCESS || E=blocked`,
    `printf 'ALLOW-HTTP=[%s]\\nALLOW-HTTPS=[%s]\\nDENY-HTTP=%s\\nDENY-HTTPS=%s\\nNO-PROXY-ROUTE=%s\\n' "$A" "$B" "$C" "$D" "$E"`,
  ].join("\n");
}

describe.runIf(dockerAvailable)("exec:docker egress enforcement against a real docker daemon", { timeout: 180_000 }, () => {
  it(
    "allowlisted host reachable through the proxy; non-allowlisted host and any proxy-free route blocked",
    async () => {
      const repoDir = await makeTempGitRepo();
      cleanupDirs.push(repoDir);
      const bundleDir = await bundleRunner();
      cleanupDirs.push(bundleDir);

      const network = `factory-itest-${process.pid}-${Date.now()}`;
      const stepImage = `factory-itest-step:${process.pid}-${Date.now()}`;
      await buildStepImage(stepImage);

      const docker = createDockerControl();
      const dockerEgress = createDockerEgressControl({ runnerDir: bundleDir, image: SIDECAR_IMAGE });
      const deps: TurnRuntimeDeps = {
        createSandbox: (await import("@ai-hero/sandcastle")).createSandbox,
        docker,
        dockerEgress,
        hostProcess: createHostProcessControl(),
        agentProviderFor: () => {
          throw new Error("no agent turns in this test");
        },
      };

      // Safety net: never leave the sidecar, networks, or the step image
      // behind, whatever happens.
      try {
        const turn = createTurnRuntime(deps).startTurn({
          kind: "shell",
          command: probeCommand(),
          workingDirectory: repoDir,
          branch: "itest/egress-probe-1",
          baseRef: "main",
          runsOn: "docker",
          image: stepImage,
          network,
          egressAllowlist: ["example.com"],
        });

        const result = await turn.done;

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("ALLOW-HTTP=[<!doctype html>");
        expect(result.stdout).toContain("Example Domain");
        expect(result.stdout).toContain("DENY-HTTP=blocked");
        expect(result.stdout).toContain("DENY-HTTPS=blocked");
        expect(result.stdout).toContain("NO-PROXY-ROUTE=blocked");
      } finally {
        await dockerEgress.remove(`${network}-egress`).catch(() => {});
        await docker.removeNetwork(network).catch(() => {});
        await docker.removeNetwork(`${network}-upstream`).catch(() => {});
        await execFileAsync("docker", ["rmi", "-f", stepImage]).catch(() => {});
      }

      // Teardown proof: the networks the turn created are gone after `done`.
      await expect(docker.networkInternal(network)).rejects.toThrow();
      await expect(docker.networkInternal(`${network}-upstream`)).rejects.toThrow();
    },
  );
});
