import { describe, expect, it, vi } from "vitest";
import { startClaimLoop, type ClaimLoopDeps } from "./claim-loop.js";
import { ProtocolError, type ClaimedStepRun, type HeartbeatReply, type ProtocolClient } from "./protocol/client.js";
import type { Capabilities } from "./capabilities.js";

const CAPABILITIES: Capabilities = {
  execMode: "docker",
  agentClis: ["claude"],
  cpuCount: 8,
  ramBytes: 16 * 1024 * 1024 * 1024,
};

function activeReply(overrides: Partial<HeartbeatReply> = {}): HeartbeatReply {
  return {
    desiredState: "active",
    cancel: [],
    unknownLeases: [],
    capsStale: false,
    latestRelease: "0.1.0",
    protocol: { min: 1, max: 1 },
    ...overrides,
  };
}

/**
 * A loop harness whose `claim` is scripted. `null` means "nothing available";
 * an Error is thrown. The loop is stopped as soon as the script runs out, so
 * no test depends on wall-clock timing.
 */
function harness(script: (ClaimedStepRun | null | Error)[], heartbeat: () => HeartbeatReply) {
  const claims: { tags: string[]; slots: number; protocolVersion: number }[] = [];
  const reportedCapabilities: unknown[] = [];
  let capabilitiesReportedResolve!: () => void;
  const capabilitiesReported = new Promise<void>((resolve) => {
    capabilitiesReportedResolve = resolve;
  });
  let index = 0;
  let exhausted!: () => void;
  const scriptExhausted = new Promise<void>((resolve) => {
    exhausted = resolve;
  });

  const protocol: ProtocolClient = {
    async claim(input) {
      claims.push(input);
      const next = script[index++];
      if (index >= script.length) exhausted();
      if (next instanceof Error) throw next;
      return next ?? null;
    },
    async heartbeat() {
      return heartbeat();
    },
    async reportCapabilities({ capabilities }) {
      reportedCapabilities.push(capabilities);
      capabilitiesReportedResolve();
    },
    async drain() {},
    async reportResult() {
      throw new Error("unused");
    },
    async mintUploadGrants() {
      throw new Error("unused");
    },
    async recordLogChunks() {},
    async submitQuestion() {
      throw new Error("unused");
    },
  };

  const logs: string[] = [];
  const deps = {
    protocol,
    git: {} as ClaimLoopDeps["git"],
    startTurn: () => {
      throw new Error("no turn should start — claim returns null in these tests");
    },
    repoDirFor: () => "/tmp/repo",
    sandboxImage: "image:test",
    capabilities: CAPABILITIES,
    tags: ["macos"],
    // A real macrotask, not a resolved promise: a loop that never stops must
    // fail on vitest's timeout, and it cannot if the event loop is starved.
    sleep: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
    log: (message: string) => logs.push(message),
  } satisfies ClaimLoopDeps;

  return { deps, claims, reportedCapabilities, logs, scriptExhausted, capabilitiesReported };
}

describe("startClaimLoop", () => {
  it("keeps returning to /claim while the control plane says active", async () => {
    const { deps, claims, scriptExhausted } = harness([null, null, null], () => activeReply());

    const loop = startClaimLoop(deps);
    await scriptExhausted;
    await loop.stop();

    expect(claims.length).toBeGreaterThanOrEqual(3);
    expect(claims[0]).toEqual({ tags: ["macos"], slots: 1, protocolVersion: 1 });
  });

  it("stops on 401 — the one fatal status in the spec's error table", async () => {
    const { deps, claims, logs } = harness(
      [new ProtocolError(401, "claim refused: runner secret invalid or revoked"), null, null],
      () => activeReply(),
    );

    const loop = startClaimLoop(deps);
    await loop.finished;

    expect(claims).toHaveLength(1);
    expect(logs.some((line) => line.includes("stopping"))).toBe(true);
  });

  it("retries after a non-fatal failure instead of giving up", async () => {
    const { deps, claims, scriptExhausted } = harness(
      [new ProtocolError(503, "claim failed: HTTP 503"), null, null],
      () => activeReply(),
    );

    const loop = startClaimLoop(deps);
    await scriptExhausted;
    await loop.stop();

    expect(claims.length).toBeGreaterThan(1);
  });

  it("stops claiming when the control plane asks the Runner to drain", async () => {
    const { deps, claims } = harness([null, null, null], () => activeReply({ desiredState: "draining" }));

    const loop = startClaimLoop(deps);
    // The loop must end on its own: `finished` never resolves if the drain
    // signal is ignored, so this fails rather than passing on a race.
    await loop.finished;

    // The Runner saw `draining` after its first (empty) claim and never went
    // back for a second — draining means "take no new work".
    expect(claims).toHaveLength(1);
  });

  it("reports the full capabilities when the heartbeat says the control plane's copy is stale", async () => {
    let replies = 0;
    const { deps, reportedCapabilities, capabilitiesReported } = harness([null, null, null], () => {
      replies += 1;
      return activeReply(replies === 1 ? { capsStale: true } : { desiredState: "draining" });
    });

    const loop = startClaimLoop(deps);
    await capabilitiesReported;
    await loop.stop();

    expect(reportedCapabilities).toEqual([CAPABILITIES]);
  });

  it("does not report capabilities when the control plane's copy is current", async () => {
    const { deps, reportedCapabilities } = harness([null, null], () => activeReply({ desiredState: "draining" }));

    const loop = startClaimLoop(deps);
    await loop.finished;

    expect(reportedCapabilities).toEqual([]);
  });

  it("reports slots: 1 — one cycle runs to completion before the next claim", async () => {
    const { deps, claims } = harness([null], () => activeReply({ desiredState: "draining" }));

    const loop = startClaimLoop(deps);
    await loop.stop();

    expect(claims.every((claim) => claim.slots === 1)).toBe(true);
  });

  it("stop() resolves only after the loop has actually left", async () => {
    const { deps } = harness([null, null], () => activeReply());
    const loop = startClaimLoop(deps);

    await loop.stop();

    const afterStop = vi.fn();
    await Promise.resolve().then(afterStop);
    expect(afterStop).toHaveBeenCalled();
  });
});
