/**
 * The docker half of `exec:docker` egress enforcement (issue #22): deploy
 * and remove the sidecar proxy container that is the step container's only
 * path off its internal per-StepRun network.
 *
 * The sidecar is the runner's own binary: the container mounts the runner's
 * entry directory read-only and runs `node main.js egress-proxy
 * --allowlist '…'` on a pinned minimal Node image. No separate image is
 * built and nothing is embedded — the enforcement code is the same
 * typechecked module (`egress-proxy.ts`) that ships in the runner bundle,
 * and it reaches the container through the exact artifact the runner itself
 * runs from (the tsc build's `dist/main.js` or the release tarball bundle).
 *
 * Deployment shape (per StepRun, mirrored in `runtime.ts`):
 *
 *   docker run -d --name <network>-egress
 *     --network <per-run network> --network <upstream network>
 *     -v <runner entry dir>:/factory-runner:ro -w /factory-runner
 *     <node image> node main.js egress-proxy --allowlist '<json>'
 *
 * The sidecar joins the internal per-StepRun network (so the step container
 * can reach it by name) AND the ordinary upstream network (so its own
 * outbound connects leave the host like any other container). Teardown is
 * `docker rm -f` — best-effort, like every teardown in this seam.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EGRESS_PROXY_PORT } from "./egress-proxy.js";

const execFileAsync = promisify(execFile);

export interface DeploySidecarOptions {
  /** Sidecar container name (derived from the StepRun's network name). */
  name: string;
  /** The internal per-StepRun network the step container lives on. */
  perRunNetwork: string;
  /** The ordinary bridge network that gives the sidecar outbound access. */
  upstreamNetwork: string;
  /** The Project's default-deny allowlist; empty denies everything. */
  allowlist: string[];
}

/** The docker egress enforcement seam: deploy the sidecar before the step container, remove it at teardown. */
export interface DockerEgressControl {
  /**
   * Deploys the allowlist-enforcing sidecar container. Resolves with the
   * proxy URL the step container's proxy env must point at. Rejects (failing
   * the turn, fail-closed) when the sidecar cannot be deployed.
   */
  deploy(options: DeploySidecarOptions): Promise<{ proxyUrl: string }>;
  /** Best-effort removal of the sidecar container. */
  remove(name: string): Promise<void>;
}

export interface DockerEgressControlDeps {
  /**
   * The host directory containing the runner entry `main.js` to mount into
   * the sidecar container. Production resolves it from `import.meta.url`
   * (`index.ts`); tests pass the directory of a bundle they built.
   */
  runnerDir: string;
  /** The Node base image for the sidecar. Pinned LTS by default; operators may override with `FACTORY_EGRESS_PROXY_IMAGE`. */
  image?: string;
  /** The proxy port inside the sidecar container (default 8080). */
  port?: number;
}

export function createDockerEgressControl(deps: DockerEgressControlDeps): DockerEgressControl {
  const image = deps.image ?? process.env["FACTORY_EGRESS_PROXY_IMAGE"] ?? "node:20-alpine";
  const port = deps.port ?? EGRESS_PROXY_PORT;
  return {
    async deploy({ name, perRunNetwork, upstreamNetwork, allowlist }) {
      // A sidecar left behind by a crashed turn of the same StepRun is the
      // one recoverable collision; removing it first makes re-claims
      // self-healing. The step container can never start before this
      // resolves, so enforcement is in place before anything untrusted runs.
      await execFileAsync("docker", ["rm", "-f", name]).catch(() => {});
      try {
        await execFileAsync("docker", [
          "run", "-d", "--name", name,
          "--network", perRunNetwork,
          "--network", upstreamNetwork,
          "-v", `${deps.runnerDir}:/factory-runner:ro`,
          "-w", "/factory-runner",
          image,
          "node", "main.js", "egress-proxy",
          "--port", String(port),
          "--allowlist", JSON.stringify(allowlist),
        ]);
      } catch (error) {
        // Fail closed: an undeployable sidecar must fail the turn, never run
        // it unenforced.
        throw new Error(
          `cannot deploy the egress proxy sidecar for '${name}': ` +
            `${error instanceof Error ? error.message : String(error)} — ` +
            "the turn is failed closed; no egress was granted",
        );
      }
      return { proxyUrl: `http://${name}:${port}` };
    },
    async remove(name) {
      // Best-effort teardown, like every teardown in this seam — the daemon
      // may already have stopped or removed the container.
      try {
        await execFileAsync("docker", ["rm", "-f", name]);
      } catch {
        // Already gone.
      }
    },
  };
}
