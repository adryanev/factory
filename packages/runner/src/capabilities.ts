/**
 * Capabilities: facts probed at every start — exec mode, installed agent
 * CLIs, cpu/ram (spec, and issue #5's binding acceptance criterion,
 * verbatim). `slots`/`tags` are deliberately absent from this module —
 * those are policy the operator writes server-side
 * (`POST /runners/{id}/policy` in `control-plane`), never something a
 * Runner reports about itself.
 *
 * Every fact-gathering primitive is injected (`CapabilityProbeDeps`) rather
 * than read ambiently from `node:os`/`node:child_process` directly, so a
 * test can assert on `probeCapabilities`'s shape without depending on what
 * happens to be installed on the machine running the test suite.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";

const execFileAsync = promisify(execFile);

export type ExecMode = "docker" | "host";

export interface Capabilities {
  execMode: ExecMode;
  agentClis: string[];
  cpuCount: number;
  ramBytes: number;
}

export interface CapabilityProbeDeps {
  checkBinaryExists(name: string): Promise<boolean>;
  dockerAvailable(): Promise<boolean>;
  cpuCount(): number;
  totalMemoryBytes(): number;
}

/** The agent CLIs this system knows how to name (spec: "Claude Code, Codex, Cursor" — CONTEXT.md's definition of Agent). Order is stable so the same machine always reports the same array shape, which matters for `hashCapabilities`. */
export const KNOWN_AGENT_CLI_NAMES = ["claude", "codex", "cursor-agent"] as const;

export async function probeCapabilities(deps: CapabilityProbeDeps): Promise<Capabilities> {
  const agentClis: string[] = [];
  for (const name of KNOWN_AGENT_CLI_NAMES) {
    if (await deps.checkBinaryExists(name)) {
      agentClis.push(name);
    }
  }
  return {
    execMode: (await deps.dockerAvailable()) ? "docker" : "host",
    agentClis,
    cpuCount: deps.cpuCount(),
    ramBytes: deps.totalMemoryBytes(),
  };
}

async function commandExists(name: string): Promise<boolean> {
  try {
    // `command -v` is POSIX-portable; this Runner ships as a Node tarball
    // for macOS/Linux hosts (spec: "Runner didistribusikan sebagai tarball
    // JS dengan prasyarat Node"), never Windows.
    await execFileAsync("command", ["-v", name], { shell: "/bin/sh" });
    return true;
  } catch {
    return false;
  }
}

async function dockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["info"]);
    return true;
  } catch {
    return false;
  }
}

export function createSystemCapabilityProbeDeps(): CapabilityProbeDeps {
  return {
    checkBinaryExists: commandExists,
    dockerAvailable,
    cpuCount: () => os.cpus().length,
    totalMemoryBytes: () => os.totalmem(),
  };
}

/**
 * Stable hash of a `Capabilities` report — this is `caps_hash` on the wire.
 * Field order in the object literal below is fixed by hand (not
 * `Object.keys` on an arbitrary object) so the hash never changes just
 * because a future refactor reorders how the object is constructed.
 */
export function hashCapabilities(capabilities: Capabilities): string {
  const canonical = JSON.stringify({
    execMode: capabilities.execMode,
    agentClis: capabilities.agentClis,
    cpuCount: capabilities.cpuCount,
    ramBytes: capabilities.ramBytes,
  });
  return createHash("sha256").update(canonical).digest("hex");
}
