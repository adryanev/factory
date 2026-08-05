/**
 * The Runner CLI. Today three subcommands, two of them real:
 *
 *  - `join` — the gated identity exchange (spec "Packaging self-host",
 *    decision 6): verify isolation (agent user cannot read the identity
 *    file) BEFORE exchanging the join token. The installer's last step is
 *    this command, but the gate lives here, in the binary — a machine
 *    whose installation half-failed simply never gets an identity.
 *  - `run` — the daemon entrypoint the macOS launchd unit runs. Reads the
 *    identity file and idles until SIGTERM; the claim/heartbeat loop lands
 *    with the Runner lifecycle issue. Loading the identity here is not a
 *    no-op: a machine that never joined (or whose identity file was
 *    corrupted) fails loudly at boot instead of polling nothing.
 *  - `scaffold` — the original smoke command; proves the package builds
 *    and imports `@factory/shared`.
 */
import { parseArgs } from "node:util";
import { isValidId } from "@factory/shared";
import { createSudoIsolationProbe } from "./isolation.js";
import { joinRunner } from "./join.js";
import { readIdentity } from "./identity.js";

export function describeRunnerScaffold(): string {
  return `factory-runner scaffold (shared id validator loaded: ${typeof isValidId === "function"})`;
}

function printUsage(): void {
  console.error(
    [
      "usage:",
      "  factory-runner join --control-plane <url> --token <join-token> --identity <file> --agent-user <user>",
      "  factory-runner run --identity <file>",
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

async function runCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { identity: { type: "string" } },
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
  console.log(`factory-runner ${identity.runnerId} running (claim loop lands with the Runner lifecycle issue)`);
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => resolve());
    process.on("SIGTERM", () => resolve());
  });
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
    case "scaffold":
    case undefined:
      console.log(describeRunnerScaffold());
      return 0;
    default:
      printUsage();
      return 2;
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
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
