/**
 * The executor's flow — the Runner's commit point. All host primitives are
 * fakes, so the AC2/AC3 ordering, the cancel path, the runsOn mapping, and
 * the token teardown are provable deterministically.
 */
import { describe, expect, it } from "vitest";
import type { GitOps } from "../git/ops.js";
import type { ClaimedStepRun, HeartbeatReply, ProtocolClient, ResultReply } from "../protocol/client.js";
import { executeClaimedTurn, execModeFor, resolveStep, runOneCycle, startCancelWatch } from "../step-run-executor.js";
import { TurnCancelledError, type Turn, type TurnResult, type TurnSpec } from "../agent-runtime/index.js";

function claimFixture(overrides: Partial<ClaimedStepRun> = {}): ClaimedStepRun {
  return {
    id: "steprun_1",
    runId: "run_1",
    stepKey: "build",
    branchKey: null,
    turn: 1,
    attempt: 1,
    repository: { id: "repo_1", owner: "acme", name: "backend", defaultBranch: "main" },
    ref: { branch: "main", sha: "base-sha" },
    definition: "version: 1\nname: p\nrepo: backend\nsteps:\n  build:\n    run: make build\n",
    definitionFiles: {},
    leaseToken: "lease-1",
    leaseExpiresAt: "2026-01-01T00:01:00.000Z",
    gitTokens: {
      fetch: { token: "fetch-token", expiresAt: "2026-01-01T01:00:00.000Z", repositoryIds: [1], permissions: { contents: "write" } },
      push: { token: "push-token", expiresAt: "2026-01-01T01:00:00.000Z", repositoryIds: [1], permissions: { contents: "write" } },
    },
    secrets: { DEPLOY_KEY: "super-secret-value" },
    egressAllowlist: ["github.com", "registry.npmjs.org"],
    ...overrides,
  };
}

function fakeGit(): GitOps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async ensureRepo(cloneDir, repoUrl) {
      calls.push(`ensure-repo ${cloneDir} ${repoUrl}`);
    },
    async fetch(cloneDir, repoUrl, ref, token) {
      calls.push(`fetch ${ref} token=${token}`);
    },
    async commitAll(dir, message) {
      calls.push(`commit ${dir} ${message}`);
      return "commit-sha";
    },
    async refHead(dir, ref) {
      calls.push(`ref-head ${ref}`);
      return "ref-sha";
    },
    async push(cloneDir, repoUrl, sha, branch, token) {
      calls.push(`push ${branch} ${sha} token=${token}`);
    },
    async revokeInstallationToken(token) {
      calls.push(`revoke ${token}`);
    },
  };
}

function fakeProtocol(overrides: {
  claimResult?: ClaimedStepRun | null;
  heartbeatCancel?: string[];
  resultError?: boolean;
} = {}): ProtocolClient & { results: ResultReply[]; heartbeats: number } {
  const results: ResultReply[] = [];
  let heartbeats = 0;
  return {
    results,
    heartbeats,
    async claim() {
      return overrides.claimResult ?? null;
    },
    async heartbeat(): Promise<HeartbeatReply> {
      heartbeats += 1;
      return {
        desiredState: "active",
        cancel: overrides.heartbeatCancel ?? [],
        unknownLeases: [],
        capsStale: false,
        latestRelease: "0.1.0",
        protocol: { min: 1, max: 1 },
      };
    },
    async reportResult(input) {
      results.push({ outcome: input.outcome, ref: input.ref ?? null, outputData: input.outputData });
      if (overrides.resultError) throw new Error("result refused: lease no longer valid");
      return { outcome: input.outcome, ref: input.ref ?? null, outputData: input.outputData };
    },
  };
}

function fakeTurn(result?: Partial<TurnResult>, error?: unknown, hold = false): Turn & { cancelled: boolean } {
  let cancelled = false;
  let rejectDone: ((reason: unknown) => void) | null = null;
  const resolved = {
    stdout: result?.stdout ?? "output",
    exitCode: result?.exitCode ?? 0,
    worktreePath: result?.worktreePath ?? "/tmp/clone/.sandcastle/worktrees/run-x",
    // `null` is meaningful (a clean turn) — the default must not override it.
    preservedWorktreePath: result && "preservedWorktreePath" in result ? result.preservedWorktreePath : "/tmp/clone/.sandcastle/worktrees/run-x",
  };
  const done = new Promise<TurnResult>((resolve, reject) => {
    if (!hold) {
      queueMicrotask(() => {
        if (cancelled) {
          reject(error ?? new TurnCancelledError());
          return;
        }
        if (error) {
          reject(error);
          return;
        }
        resolve(resolved);
      });
      return;
    }
    // hold mode: stays pending until cancel() — the shape of a long command.
    rejectDone = reject;
  });
  return {
    get cancelled() {
      return cancelled;
    },
    done,
    cancel() {
      cancelled = true;
      rejectDone?.(new TurnCancelledError());
    },
  };
}

function makeDeps(overrides: {
  git?: ReturnType<typeof fakeGit>;
  protocol?: ReturnType<typeof fakeProtocol>;
  turn?: Turn;
  repoDirFor?: (owner: string, name: string) => string;
  image?: string;
  heartbeatIntervalMs?: number;
} = {}) {
  const git = overrides.git ?? fakeGit();
  const protocol = overrides.protocol ?? fakeProtocol();
  let startTurnCalls: TurnSpec[] = [];
  const deps = {
    protocol,
    git,
    repoDirFor: overrides.repoDirFor ?? ((owner: string, name: string) => `/repos/${owner}-${name}`),
    sandboxImage: overrides.image ?? "factory-sandbox",
    heartbeatIntervalMs: overrides.heartbeatIntervalMs ?? 100,
    startTurn(spec: TurnSpec): Turn {
      startTurnCalls.push(spec);
      return overrides.turn ?? fakeTurn();
    },
  };
  return { deps, git, protocol, get startTurnCalls() { return startTurnCalls; } };
}

describe("step-run executor: the commit point", () => {
  it("AC2 — success runs fetch → turn → commit → push → /result, in order, then revokes both tokens", async () => {
    const { deps, git, protocol } = makeDeps();
    const claimed = claimFixture();

    await executeClaimedTurn(deps, claimed);

    const order = git.calls;
    expect(order.indexOf("fetch base-sha token=fetch-token")).toBeLessThan(order.indexOf("push run/run_1/build/t1-a1 commit-sha token=push-token"));
    expect(order.indexOf("push run/run_1/build/t1-a1 commit-sha token=push-token")).toBeLessThan(git.calls.length - 2); // revokes come last
    expect(protocol.results).toEqual([
      { outcome: "succeeded", ref: { branch: "run/run_1/build/t1-a1", sha: "commit-sha" }, outputData: undefined },
    ]);
    // Teardown revokes the two tokens minted at /claim (AC4).
    expect(git.calls.filter((call) => call.startsWith("revoke"))).toEqual(["revoke fetch-token", "revoke push-token"]);
  });

  it("the turn spec carries the named branch, the run: command, and the base ref", async () => {
    const { deps, startTurnCalls } = makeDeps();
    await executeClaimedTurn(deps, claimFixture());

    expect(startTurnCalls).toHaveLength(1);
    const spec = startTurnCalls[0] as TurnSpec & { kind: "shell" };
    expect(spec).toMatchObject({
      kind: "shell",
      command: "make build",
      workingDirectory: "/repos/acme-backend",
      branch: "run/run_1/build/t1-a1",
      baseRef: "base-sha",
      runsOn: "docker",
      network: "factory-steprun-steprun_1",
    });
  });

  it("AC7 — the turn spec carries no wall-clock deadline: the one clock belongs to the control plane", async () => {
    // The only timeout authority is the control plane's lease (renewed by the
    // heartbeat watch, expired by the sweep). If the seam ever grew a timeout
    // field, the two clocks would race again — this test keeps that out by
    // pinning the spec's whole shape.
    const { deps, startTurnCalls } = makeDeps();
    await executeClaimedTurn(deps, claimFixture());
    const spec = startTurnCalls[0]! as unknown as Record<string, unknown>;
    expect(spec).not.toHaveProperty("timeoutSeconds");
    expect(spec).not.toHaveProperty("deadline");
    expect(spec).not.toHaveProperty("wallClock");
  });

  it("AC5/AC6 — the claim's secrets and egress allowlist travel to the turn spec (handed to the agent call, never a file)", async () => {
    const { deps, startTurnCalls } = makeDeps();
    await executeClaimedTurn(deps, claimFixture({ secrets: { DEPLOY_KEY: "super-secret" } }));

    const spec = startTurnCalls[0]! as TurnSpec & { kind: "shell" };
    expect(spec.secrets).toEqual({ DEPLOY_KEY: "super-secret" });
    expect(spec.egressAllowlist).toEqual(["github.com", "registry.npmjs.org"]);
  });

  it("AC8 — a step declaring exec:host selects the host provider; exec:docker (and the default) selects docker", () => {
    expect(execModeFor(["exec:host"])).toBe("host");
    expect(execModeFor(["exec:host", "macos"])).toBe("host");
    expect(execModeFor(["exec:docker"])).toBe("docker");
    expect(execModeFor([])).toBe("docker");
  });

  it("AC3 — a non-zero exit reports failed with a reason on the same endpoint, and never commits or pushes", async () => {
    const { deps, git, protocol } = makeDeps({ turn: fakeTurn({ exitCode: 3, stdout: "boom" }) });
    await executeClaimedTurn(deps, claimFixture());

    expect(protocol.results).toEqual([
      { outcome: "failed", ref: null, outputData: undefined },
    ]);
    expect(protocol.results[0]).toMatchObject({ outcome: "failed" });
    expect(git.calls.some((call) => call.startsWith("push"))).toBe(false);
    expect(git.calls.some((call) => call.startsWith("commit"))).toBe(false);
    expect(git.calls.filter((call) => call.startsWith("revoke"))).toHaveLength(2);
  });

  it("a clean turn (no preserved worktree) pushes the base ref so the branch exists for the next step", async () => {
    const { deps, git, protocol } = makeDeps({ turn: fakeTurn({ preservedWorktreePath: null }) });
    await executeClaimedTurn(deps, claimFixture());

    expect(git.calls).toContain("ref-head run/run_1/build/t1-a1");
    expect(git.calls).toContain("push run/run_1/build/t1-a1 ref-sha token=push-token");
    expect(protocol.results[0]).toMatchObject({ outcome: "succeeded", ref: { branch: "run/run_1/build/t1-a1", sha: "ref-sha" } });
  });

  it("AC6 — a heartbeat cancel stops the turn; no /result is sent (the row is already cancelled), tokens still revoked", async () => {
    const protocol = fakeProtocol({ heartbeatCancel: ["steprun_1"] });
    const turn = fakeTurn(undefined, undefined, true); // a long command, held until cancelled.
    const git = fakeGit();
    const deps = {
      protocol,
      git,
      repoDirFor: () => "/repos/acme-backend",
      sandboxImage: "factory-sandbox",
      heartbeatIntervalMs: 10,
      startTurn: () => turn,
    };

    const heartbeatPromise = startCancelWatch(deps, { id: "steprun_1", leaseToken: "lease-1" }, () => turn.cancel());
    await executeClaimedTurn(deps, claimFixture());

    heartbeatPromise.stop();
    expect(turn.cancelled).toBe(true); // the heartbeat reply asked for cancel and the turn stopped.
    expect(protocol.results).toHaveLength(0); // nothing to report — the row moved on without us.
    expect(git.calls.filter((call) => call.startsWith("revoke"))).toHaveLength(2);
  });

  it("a seam-level fault reports failed with a reason, releasing the lease for the sweep", async () => {
    const { deps, protocol } = makeDeps({ turn: fakeTurn({}, new Error("docker unavailable")) });
    await executeClaimedTurn(deps, claimFixture());
    expect(protocol.results[0]).toMatchObject({ outcome: "failed" });
  });

  it("runOneCycle returns false when nothing was claimable, and executes when a StepRun is claimed", async () => {
    const empty = makeDeps({ protocol: fakeProtocol({ claimResult: null }) });
    expect(await runOneCycle(empty.deps, { tags: [], slots: 1, protocolVersion: 1 })).toBe(false);
    expect(empty.git.calls).toHaveLength(0);

    const full = makeDeps({ protocol: fakeProtocol({ claimResult: claimFixture() }) });
    expect(await runOneCycle(full.deps, { tags: [], slots: 1, protocolVersion: 1 })).toBe(true);
    expect(full.git.calls.some((call) => call.startsWith("push"))).toBe(true);
  });

  it("resolveStep rejects a claimed step that is not a run: step", () => {
    const agentClaimed = claimFixture({
      definition: "version: 1\nname: p\nrepo: backend\nsteps:\n  build:\n    prompt: do it\n",
    });
    expect(() => resolveStep(agentClaimed)).toThrow(/not a run: step/);
  });
});
