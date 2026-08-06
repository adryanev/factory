/**
 * The Runner CLI. Today three subcommands, two of them real:
 *
 *  - `join` — the gated identity exchange (spec "Packaging self-host",
 *    decision 6): verify isolation (agent user cannot read the identity
 *    file) BEFORE exchanging the join token. The installer's last step is
 *    this command, but the gate lives here, in the binary — a machine
 *    whose installation half-failed simply never gets an identity.
 *  - `run` — the daemon entrypoint the macOS launchd unit runs. Reads the
 *    identity file, probes capabilities, and runs the claim loop until
 *    SIGTERM. Loading the identity here is not a no-op: a machine that never
 *    joined (or whose identity file was corrupted) fails loudly at boot
 *    instead of polling nothing.
 *  - `scaffold` — the original smoke command; proves the package builds
 *    and imports `@factory/shared`.
 */
import { parseArgs } from "node:util";
import { realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isValidId } from "@factory/shared";
import { createSudoIsolationProbe } from "./isolation.js";
import { joinRunner } from "./join.js";
import { readIdentity } from "./identity.js";
import { startClaimLoop } from "./claim-loop.js";
import { createProtocolClient } from "./protocol/client.js";
import { createSystemGitOps } from "./git/ops.js";
import { createSystemCapabilityProbeDeps, probeCapabilities } from "./capabilities.js";
import { runEgressProxy } from "./agent-runtime/egress-proxy.js";
import { createSystemTurnRuntimeDeps, createTurnRuntime } from "./agent-runtime/index.js";

export function describeRunnerScaffold(): string {
  return `factory-runner scaffold (shared id validator loaded: ${typeof isValidId === "function"})`;
}

function printUsage(): void {
  console.error(
    [
      "usage:",
      "  factory-runner join --control-plane <url> --token <join-token> --identity <file> --agent-user <user>",
      "  factory-runner run --identity <file> [--tags a,b] [--work-dir <dir>] [--sandbox-image <ref>]",
      "                     [--allow-unenforced-docker-egress]",
      "  factory-runner egress-proxy --allowlist '<json>' [--port <port>]",
      "  factory-runner scaffold",
    ].join("\n"),
  );
}

async function joinCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      "control-plane": { type: "string" },
      token: { type: "string" },
      identity: { type: "string" },
      "agent-user": { type: "string" },
    },
    strict: true,
  });
  const baseUrl = values["control-plane"];
  const token = values["token"];
  const identityFilePath = values["identity"];
  const agentUser = values["agent-user"];
  if (!baseUrl || !token || !identityFilePath || !agentUser) {
    printUsage();
    return 2;
  }

  const { runnerId } = await joinRunner({
    baseUrl,
    token,
    identityFilePath,
    agentUser,
    probe: createSudoIsolationProbe(agentUser),
  });
  console.log(`joined as ${runnerId}; identity written to ${identityFilePath}`);
  return 0;
}

/**
 * The sandbox image `exec:docker` turns run in. The spec names no image, so
 * this is a Runner-operator concern with one tunable spot.
 */
const DEFAULT_SANDBOX_IMAGE = "ghcr.io/ai-hero/sandcastle-base:latest";

async function runCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      identity: { type: "string" },
      tags: { type: "string" },
      "work-dir": { type: "string" },
      "sandbox-image": { type: "string" },
      "allow-unenforced-docker-egress": { type: "boolean" },
    },
    strict: true,
  });
  const identityFilePath = values["identity"];
  if (!identityFilePath) {
    printUsage();
    return 2;
  }

  const identity = await readIdentity(identityFilePath);
  if (identity === null) {
    throw new Error(`no identity at ${identityFilePath} — this machine has never joined`);
  }

  const workDir = values["work-dir"] ?? path.join(path.dirname(identityFilePath), "repos");
  const tags = (values["tags"] ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);

  // Off unless the operator says otherwise — and now it means "turn egress
  // enforcement off": by default `exec:docker` runs on an internal network
  // with an allowlist-enforcing sidecar proxy as its only exit (issue #22,
  // ADR 0005). Passing this flag restores the pre-enforcement shape: the
  // sandbox joins an ordinary bridge network and reaches whatever the host
  // reaches.
  const allowUnenforcedDockerEgress =
    values["allow-unenforced-docker-egress"] === true ||
    process.env["FACTORY_ALLOW_UNENFORCED_DOCKER_EGRESS"] === "1";

  const capabilities = await probeCapabilities(createSystemCapabilityProbeDeps());
  const runtime = createTurnRuntime(
    createSystemTurnRuntimeDeps({ hostAgentUser: identity.agentUser, allowUnenforcedDockerEgress }),
  );

  const protocol = createProtocolClient(identity.baseUrl, identity.secret);
  const loop = startClaimLoop({
    protocol,
    git: createSystemGitOps(),
    startTurn: (spec) => runtime.startTurn(spec),
    repoDirFor: (owner, name) => path.join(workDir, owner, name),
    sandboxImage: values["sandbox-image"] ?? process.env["FACTORY_SANDBOX_IMAGE"] ?? DEFAULT_SANDBOX_IMAGE,
    capabilities,
    tags,
  });

  console.log(`factory-runner ${identity.runnerId} running against ${identity.baseUrl}`);

  // Two ways this daemon ends, and it must wait on both: a signal, or the
  // loop deciding for itself (a revoked secret, an operator draining this
  // Runner). Waiting only on the signal would leave a stopped Runner holding
  // the process open forever under launchd's KeepAlive.
  let signalled = false;
  const signal = new Promise<void>((resolve) => {
    const shutdown = (name: string): void => {
      signalled = true;
      console.log(`factory-runner: ${name} — draining`);
      resolve();
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  });

  await Promise.race([loop.finished, signal]);

  if (signalled) {
    // Best-effort: tell the control plane to stop handing this Runner work
    // while the in-flight cycle finishes. A failure here changes nothing —
    // the loop is stopping regardless, and the lease sweep is the backstop.
    await protocol.drain().catch((error: unknown) => {
      console.error("factory-runner: drain request failed, stopping anyway", error);
    });
  }

  await loop.stop();
  console.log("stopping");
  return 0;
}

export async function cli(argv: string[]): Promise<number> {
  const [subcommand, ...rest] = argv;
  switch (subcommand) {
    case "join":
      return joinCommand(rest);
    case "run":
      return runCommand(rest);
    case "egress-proxy":
      // Not an operator-facing command: the Runner deploys this inside the
      // egress sidecar container (issue #22) by mounting its own bundle and
      // running `node main.js egress-proxy --allowlist '…'`.
      return runEgressProxy(rest);
    case "scaffold":
    case undefined:
      console.log(describeRunnerScaffold());
      return 0;
    default:
      printUsage();
      return 2;
  }
}

/**
 * The main-module test. Compared against the entry's *realpath*: ESM resolves
 * `import.meta.url` to the resolved real path, while `process.argv[1]` keeps
 * the literal invocation path — a symlinked invocation (e.g. `/var/folders`
 * on macOS, a `node_modules/.bin` link, a `/usr/local/bin` symlink) would
 * silently no-op without this. The same comparison guards the `egress-proxy`
 * subcommand, which runs the bundle from inside a docker mount.
 */
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain) {
  cli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
