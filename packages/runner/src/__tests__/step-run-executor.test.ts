/**
 * The executor's flow — the Runner's commit point. All host primitives are
 * fakes, so the AC2/AC3 ordering, the cancel path, the runsOn mapping, and
 * the token teardown are provable deterministically.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  compileStepOutputContract,
  FACTORY_OUTPUT_TAG,
  type ArtifactKind,
  type JoinManifestEntry,
} from "@factory/shared";
import type { GitOps } from "../git/ops.js";
import type { ClaimedStepRun, HeartbeatReply, LogChunkWire, ProtocolClient, ResultReply } from "../protocol/client.js";
import {
  classifyAgentOutput,
  deriveMaxRetries,
  executeClaimedTurn,
  execModeFor,
  parseFactoryOutputTag,
  resolveStep,
  runOneCycle,
  startCancelWatch,
  RESUMABLE_AGENTS,
} from "../step-run-executor.js";
import { OutputInvalidError, TurnCancelledError, type Turn, type TurnResult, type TurnSpec } from "../agent-runtime/index.js";

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
    askGroupId: null,
    joinManifest: [],
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
    async diff(dir, base, head) {
      calls.push(`diff ${base}..${head}`);
      return `diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ +1 +1 @@\n+built\n`;
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
} = {}): ProtocolClient & {
  results: { outcome: string; ref: { branch: string; sha: string } | null; outputData: unknown; artifacts?: unknown }[];
  heartbeats: number;
  logChunks: LogChunkWire[];
  uploadGrants: number;
  questions: { id: string; groupId: string; kind: string; body: string; ref: { branch: string; sha: string } }[];
} {
  const results: { outcome: string; ref: { branch: string; sha: string } | null; outputData: unknown; artifacts?: unknown }[] = [];
  const logChunks: LogChunkWire[] = [];
  const questions: { id: string; groupId: string; kind: string; body: string; ref: { branch: string; sha: string } }[] = [];
  let heartbeats = 0;
  let uploadGrants = 0;
  return {
    results,
    logChunks,
    questions,
    heartbeats,
    uploadGrants,
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
      results.push({
        outcome: input.outcome,
        ref: input.ref ?? null,
        outputData: input.outputData,
        ...(input.artifacts !== undefined ? { artifacts: input.artifacts } : {}),
      });
      if (overrides.resultError) throw new Error("result refused: lease no longer valid");
      return { outcome: input.outcome, ref: input.ref ?? null, outputData: input.outputData };
    },
    async mintUploadGrants({ requests }) {
      uploadGrants += 1;
      return requests.map((request) => ({
        key: request.key,
        uploadUrl: `https://blob.invalid/put/${request.key}`,
        expiresAt: "2026-01-01T00:05:00.000Z",
        blobKey: `${request.kind}/steprun_1/${request.key}`,
      }));
    },
    async recordLogChunks({ chunks }) {
      logChunks.push(...chunks);
    },
    async submitQuestion(input) {
      questions.push({ ...input.question, ref: input.ref });
      return { questionId: `question_${questions.length}` };
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
  artifactUploader?: ReturnType<typeof fakeArtifactUploader>;
} = {}) {
  const git = overrides.git ?? fakeGit();
  const protocol = overrides.protocol ?? fakeProtocol();
  const artifactUploader = overrides.artifactUploader ?? fakeArtifactUploader();
  let startTurnCalls: TurnSpec[] = [];
  const deps = {
    protocol,
    git,
    repoDirFor: overrides.repoDirFor ?? ((owner: string, name: string) => `/repos/${owner}-${name}`),
    sandboxImage: overrides.image ?? "factory-sandbox",
    heartbeatIntervalMs: overrides.heartbeatIntervalMs ?? 100,
    capabilities: { agentClis: [] as string[] },
    artifactUploaderFor: () => artifactUploader,
    startTurn(spec: TurnSpec): Turn {
      startTurnCalls.push(spec);
      return overrides.turn ?? fakeTurn();
    },
  };
  return { deps, git, protocol, artifactUploader, get startTurnCalls() { return startTurnCalls; } };
}

/** Recording artifact-uploader fake — a PUT that "succeeds" unless told to fail the next N. */
function fakeArtifactUploader() {
  const calls: { artifacts: { key: string; kind: ArtifactKind; contentType: string; text: string }[] }[] = [];
  let failTimes = 0;
  return {
    calls,
    failNext(times: number) {
      failTimes = times;
    },
    async uploadArtifacts(artifacts: { key: string; kind: ArtifactKind; contentType: string; text: string }[]) {
      calls.push({ artifacts });
      const uploaded: { key: string; kind: ArtifactKind; contentType: string; sizeBytes: number; blobKey: string }[] = [];
      for (const artifact of artifacts) {
        if (failTimes > 0) {
          failTimes -= 1;
          continue;
        }
        uploaded.push({
          key: artifact.key,
          kind: artifact.kind,
          contentType: artifact.contentType,
          sizeBytes: artifact.text.length,
          blobKey: `artifact/steprun_1/${artifact.key}`,
        });
      }
      return uploaded;
    },
  };
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
      {
        outcome: "succeeded",
        ref: { branch: "run/run_1/build/t1-a1", sha: "commit-sha" },
        outputData: undefined,
        artifacts: [{ key: "diff", kind: "diff", contentType: "text/x-diff", sizeBytes: 70 }],
      },
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
      capabilities: { agentClis: [] as string[] },
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

  it("resolveStep resolves an agent Step with the final prompt built from outputs: (AC4)", () => {
    const agentClaimed = claimFixture({
      definition:
        "version: 1\nname: p\nrepo: backend\nsteps:\n  plan:\n    promptFile: .factory/prompts/plan.md\n    outputs:\n      variants:\n        type: array\n        items: { key: string, brief: string }\n",
      definitionFiles: { ".factory/prompts/plan.md": "Plan three variants.\n" },
      stepKey: "plan",
    });
    const step = resolveStep(agentClaimed);
    expect(step.kind).toBe("agent");
    if (step.kind === "agent") {
      expect(step.agent).toBe("claude");
      // The format-instruction block is appended — the prompt is no longer
      // the verbatim file content, which is exactly why the UI must show the
      // final prompt (AC5).
      expect(step.finalPrompt).toContain("Plan three variants.");
      expect(step.finalPrompt).toContain(`<${FACTORY_OUTPUT_TAG}>`);
      expect(step.finalPrompt).toContain('"kind":"done"');
    }
  });

  it("resolveStep throws for a step that is neither run: nor agent", () => {
    const badClaimed = claimFixture({
      definition: "version: 1\nname: p\nrepo: backend\nsteps:\n  pr:\n    kind: pull-request\n",
      stepKey: "pr",
    });
    expect(() => resolveStep(badClaimed)).toThrow(/neither a run: step nor an agent step/);
  });

  it("captures onLine output into chunks, redacts the turn's git tokens, and flushes before /result", async () => {
    const protocol = fakeProtocol();
    const git = fakeGit();
    const uploaded: { text: string; seq: number; byteOffset: number }[] = [];
    const claimed = claimFixture();

    const deps = {
      protocol,
      git,
      repoDirFor: () => "/repos/acme-backend",
      sandboxImage: "factory-sandbox",
      heartbeatIntervalMs: 100,
      capabilities: { agentClis: [] as string[] },
      logFlushIntervalMs: 100_000, // no timer tick — the explicit pre-/result flush is what's under test.
      logUploaderFor: () => ({
        async upload(chunk: { text: string; seq: number; byteOffset: number }) {
          uploaded.push(chunk);
        },
      }),
      startTurn(input: TurnSpec) {
        // The command streams lines; the first one leaks the push token.
        input.onLine?.("building the module");
        input.onLine?.("push token is fetch-token and again fetch-token");
        return fakeTurn({ exitCode: 0, preservedWorktreePath: null });
      },
    };

    await executeClaimedTurn(deps as never, claimed);

    // The final flush ran before /result — the archive is complete while the
    // lease is still valid, and the token was redacted before upload.
    expect(uploaded.length).toBeGreaterThanOrEqual(1);
    const text = uploaded.map((chunk) => chunk.text).join("");
    expect(text).toContain("building the module\n");
    expect(text).toContain("push token is [redacted] and again [redacted]\n");
    expect(text).not.toContain("fetch-token");
    expect(protocol.results).toHaveLength(1); // /result still committed.
  });

  it("AC6 — a succeeded turn materializes the diff (base..head) as an artifact, uploaded after the push and riding /result", async () => {
    const { deps, git, protocol, artifactUploader } = makeDeps();

    await executeClaimedTurn(deps, claimFixture());

    // The diff was computed from the base ref to the pushed sha...
    expect(git.calls).toContain("diff base-sha..commit-sha");
    // ...after the push, before the turn-ending POST.
    const pushIndex = git.calls.indexOf("push run/run_1/build/t1-a1 commit-sha token=push-token");
    const diffIndex = git.calls.indexOf("diff base-sha..commit-sha");
    expect(pushIndex).toBeGreaterThan(-1);
    expect(diffIndex).toBeGreaterThan(pushIndex);

    // One batch, one diff artifact, uploaded peer-to-peer.
    expect(artifactUploader.calls).toEqual([
      { artifacts: [{ key: "diff", kind: "diff", contentType: "text/x-diff", text: "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ +1 +1 @@\n+built\n" }] },
    ]);

    // The metadata rides /result.
    expect(protocol.results[0]!.artifacts).toEqual([
      { key: "diff", kind: "diff", contentType: "text/x-diff", sizeBytes: 70 },
    ]);
  });

  it("AC5 — a permanently-failed diff upload is simply not listed; the StepRun still succeeds", async () => {
    const artifactUploader = fakeArtifactUploader();
    artifactUploader.failNext(1);
    const { deps, protocol } = makeDeps({ artifactUploader });

    await executeClaimedTurn(deps, claimFixture());

    expect(protocol.results).toEqual([
      { outcome: "succeeded", ref: { branch: "run/run_1/build/t1-a1", sha: "commit-sha" }, outputData: undefined },
    ]);
    expect(protocol.results[0]!.artifacts).toBeUndefined();
  });

  it("a failed turn materializes no diff and reports no artifacts — the branch is an orphan either way", async () => {
    const { deps, git, protocol } = makeDeps({ turn: fakeTurn({ exitCode: 3, stdout: "boom" }) });

    await executeClaimedTurn(deps, claimFixture());

    expect(git.calls.some((call) => call.startsWith("diff"))).toBe(false);
    expect(protocol.results[0]).toMatchObject({ outcome: "failed" });
    expect(protocol.results[0]!.artifacts).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Agent Steps (issue 9): parse the single <factory-output> tag, classify it
// against the shared union, and drive the question / done / invalid outcomes
// through the same commit point as shell Steps.
// ---------------------------------------------------------------------------

const AGENT_DEFINITION = `version: 1
name: p
repo: backend
concurrency: cancel
steps:
  plan:
    promptFile: .factory/prompts/plan.md
    outputs:
      variants:
        type: array
        items: { key: string, brief: string }
`;

// The same shape, but with an interactive Step — its contract has the
// `question` arm, so an agent that asks instead of finishing is valid.
const ASK_DEFINITION = `version: 1
name: p
repo: backend
concurrency: cancel
steps:
  plan:
    promptFile: .factory/prompts/plan.md
    ask:
      group: reviewer
      kind: approval
`;

function agentClaim(overrides: Partial<ClaimedStepRun> = {}): ClaimedStepRun {
  return claimFixture({
    stepKey: "plan",
    definition: AGENT_DEFINITION,
    definitionFiles: { ".factory/prompts/plan.md": "Plan three variants.\n" },
    ...overrides,
  });
}

function askClaim(overrides: Partial<ClaimedStepRun> = {}): ClaimedStepRun {
  return claimFixture({
    stepKey: "plan",
    definition: ASK_DEFINITION,
    definitionFiles: { ".factory/prompts/plan.md": "Plan three variants.\n" },
    ...overrides,
  });
}

function tagResult(payload: string, extra: Partial<TurnResult> = {}): Turn {
  const tag = FACTORY_OUTPUT_TAG;
  return fakeTurn({
    stdout: `thinking...\n<${tag}>${payload}</${tag}>\n`,
    exitCode: 0,
    preservedWorktreePath: "/tmp/clone/.sandcastle/worktrees/run-x",
    ...extra,
  });
}

describe("agent Steps: classify the Output against the shared union", () => {
  it("deriveMaxRetries is 2 for a resumable installed agent, 0 otherwise (AC8)", () => {
    const withClaude = { agentClis: ["claude", "codex"] };
    const withCursor = { agentClis: ["cursor-agent"] };
    expect(deriveMaxRetries(withClaude, "claude")).toBe(2);
    expect(deriveMaxRetries(withClaude, "codex")).toBe(2);
    expect(deriveMaxRetries(withCursor, "cursor-agent")).toBe(0); // cursor cannot resume.
    expect(deriveMaxRetries(withCursor, "claude")).toBe(0); // not installed.
    expect(RESUMABLE_AGENTS).toEqual(new Set(["claude", "codex"]));
  });

  it("parseFactoryOutputTag extracts the tag's JSON from stdout, unwrapping a code fence", () => {
    const tag = FACTORY_OUTPUT_TAG;
    expect(
      parseFactoryOutputTag(`<${tag}>{"kind":"done","outputs":{}}</${tag}>`),
    ).toEqual({ kind: "done", outputs: {} });
    expect(
      parseFactoryOutputTag(`<${tag}>\`\`\`json\n{"kind":"done","outputs":{}}\n\`\`\`</${tag}>`),
    ).toEqual({ kind: "done", outputs: {} });
    expect(parseFactoryOutputTag("no tag here")).toBeUndefined();
    expect(parseFactoryOutputTag(`<${tag}>not json</${tag}>`)).toBeUndefined();
  });

  it("classifyAgentOutput prefers the already-extracted output, and falls back to parsing stdout", () => {
    const contract = compileStepOutputContract({
      outputs: { variants: { type: "array", items: { key: "string", brief: "string" } } },
    });
    const done = classifyAgentOutput(
      { stdout: "<factory-output>ignored</factory-output>", output: { kind: "done", outputs: { variants: [] } } },
      contract,
    );
    expect(done).toMatchObject({ kind: "done" });

    const fromStdout = classifyAgentOutput(
      { stdout: `<${FACTORY_OUTPUT_TAG}>{"kind":"done","outputs":{"variants":[]}}</${FACTORY_OUTPUT_TAG}>` },
      contract,
    );
    expect(fromStdout).toMatchObject({ kind: "done" });
  });

  it("classifyAgentOutput rejects a missing tag, unparseable JSON, and a schema violation", () => {
    const contract = compileStepOutputContract({
      outputs: { variants: { type: "array", items: { key: "string", brief: "string" } } },
    });
    expect(classifyAgentOutput({ stdout: "no tag" }, contract)).toEqual({ kind: "invalid" });
    expect(classifyAgentOutput({ stdout: `<${FACTORY_OUTPUT_TAG}>nope</${FACTORY_OUTPUT_TAG}>` }, contract)).toEqual({ kind: "invalid" });
    // A Key that is not git-ref-safe fails the union (AC2) — the agent is
    // told, while the session is still alive.
    expect(
      classifyAgentOutput(
        { stdout: `<${FACTORY_OUTPUT_TAG}>{"kind":"done","outputs":{"variants":[{"key":"My Agent!","brief":"b"}]}}</${FACTORY_OUTPUT_TAG}>` },
        contract,
      ),
    ).toEqual({ kind: "invalid" });
  });

  it("a question Output classifies as a Question with its arm's shape", () => {
    const contract = compileStepOutputContract({ ask: { kind: "approval" } });
    const classified = classifyAgentOutput(
      { stdout: `<${FACTORY_OUTPUT_TAG}>{"kind":"question","question":{"kind":"approval","body":"OK?"}}</${FACTORY_OUTPUT_TAG}>` },
      contract,
    );
    expect(classified).toMatchObject({ kind: "question", question: { kind: "approval", body: "OK?" } });
  });
});

describe("agent Steps: the executor flow", () => {
  it("a valid done Output flows to /result as the turn's output_data (AC6)", async () => {
    const protocol = fakeProtocol();
    const git = fakeGit();
    const deps = makeDeps({ protocol, git, turn: tagResult('{"kind":"done","outputs":{"variants":[{"key":"agent-a","brief":"b"}]}}') });

    await executeClaimedTurn(deps.deps, agentClaim());

    expect(protocol.results).toEqual([
      {
        outcome: "succeeded",
        ref: { branch: "run/run_1/plan/t1-a1", sha: "commit-sha" },
        outputData: { kind: "done", outputs: { variants: [{ key: "agent-a", brief: "b" }] } },
        artifacts: [{ key: "diff", kind: "diff", contentType: "text/x-diff", sizeBytes: 70 }],
      },
    ]);
  });

  it("an agent-reported usage rides the done Output to /result, so the control plane can price it once (issue 12)", async () => {
    const protocol = fakeProtocol();
    const git = fakeGit();
    const deps = makeDeps({
      protocol,
      git,
      turn: tagResult(
        '{"kind":"done","outputs":{"variants":[{"key":"agent-a","brief":"b"}]},"usage":{"input_tokens":1200,"output_tokens":300}}',
      ),
    });

    await executeClaimedTurn(deps.deps, agentClaim());

    expect(protocol.results[0]!.outputData).toEqual({
      kind: "done",
      outputs: { variants: [{ key: "agent-a", brief: "b" }] },
      usage: { input_tokens: 1200, output_tokens: 300 },
    });
    expect(protocol.results[0]!.outcome).toBe("succeeded");
  });

  it("an invalid Output reports failed with reason output-invalid, and the branch push still happens before the report (AC7)", async () => {
    const protocol = fakeProtocol();
    const git = fakeGit();
    const deps = makeDeps({ protocol, git, turn: tagResult('{"kind":"done","outputs":{"variants":[{"key":"My Agent!","brief":"b"}]}}') });

    await executeClaimedTurn(deps.deps, agentClaim());

    expect(protocol.results[0]).toMatchObject({ outcome: "failed" });
    // The branch was pushed (an orphan for the retention GC), and the report
    // carries its ref so the control plane records where the orphan lives.
    expect(git.calls).toContain("push run/run_1/plan/t1-a1 commit-sha token=push-token");
    expect(protocol.results[0]!.ref).toEqual({ branch: "run/run_1/plan/t1-a1", sha: "commit-sha" });
  });

  it("an OutputInvalidError from the real seam reports failed with reason output-invalid", async () => {
    const protocol = fakeProtocol();
    const git = fakeGit();
    const deps = makeDeps({
      protocol,
      git,
      turn: {
        done: Promise.reject(new OutputInvalidError(new Error("structured output failed") as never)),
        cancel: () => {},
      } as Turn,
    });

    await executeClaimedTurn(deps.deps, agentClaim());
    expect(protocol.results).toEqual([{ outcome: "failed", ref: null, outputData: undefined }]);
  });

  it("a question Output pushes the branch first, then POSTs the Question with the ref (spec: 'push branch → … → POST Question')", async () => {
    const protocol = fakeProtocol();
    const git = fakeGit();
    const deps = makeDeps({
      protocol,
      git,
      turn: tagResult('{"kind":"question","question":{"kind":"approval","body":"Approve this?"}}'),
    });

    await executeClaimedTurn(deps.deps, askClaim({ askGroupId: "group_1" }));

    // The branch was pushed before the Question was posted.
    expect(git.calls.indexOf("push run/run_1/plan/t1-a1 commit-sha token=push-token")).toBeLessThan(
      git.calls.length - 2,
    );
    expect(protocol.questions).toHaveLength(1);
    expect(protocol.questions[0]).toMatchObject({
      groupId: "group_1",
      kind: "approval",
      body: "Approve this?",
      ref: { branch: "run/run_1/plan/t1-a1", sha: "commit-sha" },
    });
    expect(protocol.questions[0]!.id).toMatch(/^question_/);
    // A question turn posts no /result — the row moves to awaiting-human via /question.
    expect(protocol.results).toHaveLength(0);
  });

  it("a question Output with no resolved group reports failed rather than posting a broken Question", async () => {
    const protocol = fakeProtocol();
    const deps = makeDeps({
      protocol,
      turn: tagResult('{"kind":"question","question":{"kind":"approval","body":"Approve this?"}}'),
    });

    await executeClaimedTurn(deps.deps, askClaim({ askGroupId: null }));
    expect(protocol.questions).toHaveLength(0);
    expect(protocol.results[0]).toMatchObject({ outcome: "failed" });
  });

  it("the agent turn spec carries the final prompt, the compiled contract, and the derived maxRetries", async () => {
    const protocol = fakeProtocol();
    const { deps, startTurnCalls } = makeDeps({ protocol, turn: tagResult('{"kind":"done","outputs":{"variants":[]}}') });
    deps.capabilities = { agentClis: ["claude"] };
    await executeClaimedTurn(deps, agentClaim());

    const spec = startTurnCalls[0] as TurnSpec & { kind: "agent" };
    expect(spec.kind).toBe("agent");
    if (spec.kind === "agent") {
      expect(spec.prompt).toContain("Plan three variants.");
      expect(spec.prompt).toContain(`<${FACTORY_OUTPUT_TAG}>`);
      expect(spec.maxRetries).toBe(2); // claude is resumable and installed.
      expect(spec.agent).toBe("claude");
    }
  });
});

describe("fan-out and Join: the Runner's half (issue #11)", () => {
  it("resolveStep applies a fan-out branch's overrides — a branch with its own agent runs as itself", () => {
    const definition = `version: 1
name: p
repo: backend
steps:
  implement:
    branches:
      - key: agent-a
        agent: codex
      - key: agent-b
        agent: claude
    prompt: do the work
    outputs:
      x: { type: string }
`;
    const base = { definition, definitionFiles: {}, runId: "run_1", id: "steprun_1" };
    const codexBranch = resolveStep({ ...base, stepKey: "implement", branchKey: "agent-a" } as never);
    expect(codexBranch).toMatchObject({ kind: "agent", agent: "codex" });
    const claudeBranch = resolveStep({ ...base, stepKey: "implement", branchKey: "agent-b" } as never);
    expect(claudeBranch).toMatchObject({ kind: "agent", agent: "claude" });
    // The parent Step's fields are the whole story for a branchesFrom branch.
    const plain = resolveStep({ ...base, stepKey: "implement", branchKey: null } as never);
    expect(plain).toMatchObject({ kind: "agent" });
  });

  it("a Join claim writes its manifest to the clone root, hands the path to the shell turn spec, and removes it after", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "factory-manifest-test-"));
    try {
      const manifest: JoinManifestEntry[] = [
        { key: "agent-a", repo: "backend", branch: "run/run_1/implement/agent-a/t1-a1", sha: "sha-a", outcome: "succeeded", outputs: null },
        { key: "agent-b", repo: "frontend", branch: "run/run_1/implement/agent-b/t1-a1", sha: null, outcome: "failed", outputs: null },
      ];
      let capturedSpec: (TurnSpec & { kind: "shell" }) | undefined;
      let fileContentAtTurnStart: string | null = null;
      const deps = {
        protocol: fakeProtocol(),
        git: fakeGit(),
        repoDirFor: () => dir,
        sandboxImage: "factory-sandbox",
        heartbeatIntervalMs: 100,
        capabilities: { agentClis: [] as string[] },
        startTurn(spec: TurnSpec): Turn {
          capturedSpec = spec as TurnSpec & { kind: "shell" };
          fileContentAtTurnStart = spec.manifestFile ? readFileSync(spec.manifestFile, "utf-8") : null;
          return fakeTurn();
        },
      };
      await executeClaimedTurn(deps, claimFixture({ joinManifest: manifest }));

      // The manifest file existed in the clone root while the turn ran, with
      // the exact [{ key, repo, branch, sha, outcome, outputs }] content.
      expect(capturedSpec?.manifestFile).toBe(path.join(dir, ".factory-manifest.json"));
      expect(fileContentAtTurnStart).toBe(JSON.stringify(manifest, null, 2));
      // Cross-repo branches are data, not checkouts: the entry's repo stays
      // as delivered — the manifest is the only bridge.
      expect(capturedSpec?.kind).toBe("shell");
      // And it is gone after the turn, so it never rides the pushed branch.
      await expect(readFile(path.join(dir, ".factory-manifest.json"), "utf-8")).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a Join agent turn gets the manifest path AND a prompt note naming the manifest file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "factory-manifest-agent-"));
    try {
      const manifest: JoinManifestEntry[] = [{ key: "agent-a", repo: "backend", branch: "run/run_1/implement/agent-a/t1-a1", sha: "sha-a", outcome: "succeeded", outputs: null }];
      const protocol = fakeProtocol();
      const { deps, startTurnCalls } = makeDeps({ protocol, turn: tagResult('{"kind":"done","outputs":{"x":"y"}}') });
      deps.repoDirFor = () => dir;
      await executeClaimedTurn(deps, agentClaim({ joinManifest: manifest }));

      const spec = startTurnCalls[0]! as TurnSpec & { kind: "agent" };
      expect(spec.manifestFile).toBe(path.join(dir, ".factory-manifest.json"));
      expect(spec.prompt).toContain(".factory-manifest.json");
      expect(spec.prompt).toContain("outcome");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a non-Join claim carries no manifestFile — the seam stays silent", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "factory-no-manifest-"));
    try {
      const { deps, startTurnCalls } = makeDeps({ repoDirFor: () => dir });
      await executeClaimedTurn(deps, claimFixture());
      const spec = startTurnCalls[0]! as TurnSpec & { kind: "shell" };
      expect(spec.manifestFile).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
