import { describe, expect, it } from "vitest";
import { hashCapabilities, probeCapabilities, type CapabilityProbeDeps } from "./capabilities.js";

function fakeDeps(overrides: Partial<CapabilityProbeDeps> = {}): CapabilityProbeDeps {
  return {
    checkBinaryExists: async () => false,
    dockerAvailable: async () => true,
    cpuCount: () => 8,
    totalMemoryBytes: () => 34_359_738_368,
    ...overrides,
  };
}

describe("probeCapabilities", () => {
  it("reports execMode: docker when Docker is reachable, host otherwise", async () => {
    const docker = await probeCapabilities(fakeDeps({ dockerAvailable: async () => true }));
    expect(docker.execMode).toBe("docker");

    const host = await probeCapabilities(fakeDeps({ dockerAvailable: async () => false }));
    expect(host.execMode).toBe("host");
  });

  it("lists only the agent CLIs actually found on the machine, in the known-name order", async () => {
    const capabilities = await probeCapabilities(
      fakeDeps({ checkBinaryExists: async (name) => name === "codex" || name === "claude" }),
    );
    expect(capabilities.agentClis).toEqual(["claude", "codex"]);
  });

  it("carries cpu count and ram straight through from the injected probe", async () => {
    const capabilities = await probeCapabilities(fakeDeps({ cpuCount: () => 16, totalMemoryBytes: () => 1024 }));
    expect(capabilities.cpuCount).toBe(16);
    expect(capabilities.ramBytes).toBe(1024);
  });
});

describe("hashCapabilities", () => {
  it("is deterministic — the same capabilities report always hashes the same", () => {
    const capabilities = { execMode: "docker" as const, agentClis: ["claude"], cpuCount: 8, ramBytes: 1024 };
    expect(hashCapabilities(capabilities)).toBe(hashCapabilities({ ...capabilities }));
  });

  it("changes when any field changes — the whole point of caps_hash is detecting drift", () => {
    const base = { execMode: "docker" as const, agentClis: ["claude"], cpuCount: 8, ramBytes: 1024 };
    const baseHash = hashCapabilities(base);

    expect(hashCapabilities({ ...base, execMode: "host" })).not.toBe(baseHash);
    expect(hashCapabilities({ ...base, agentClis: ["claude", "codex"] })).not.toBe(baseHash);
    expect(hashCapabilities({ ...base, cpuCount: 16 })).not.toBe(baseHash);
    expect(hashCapabilities({ ...base, ramBytes: 2048 })).not.toBe(baseHash);
  });
});
