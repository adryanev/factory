/**
 * The Runner's real step-run execution (issue #6): a claimed StepRun goes
 * through the commit point that turns git into the bus —
 *
 *   fetch base ref → turn in the sandbox (agent-runtime) → commit → push the
 *   named branch → POST /result
 *
 * and the tokens minted at `/claim` are revoked at teardown, whatever
 * happened (spec: "token ... lalu dihapus saat teardown"). The order is the
 * acceptance criterion: push happens **before** `/result` (AC2), and a
 * failed turn uses the same endpoint with `outcome: failed` + `reason`
 * (AC3). Everything host-touching is injected (`ProtocolClient`, `GitOps`,
 * `startTurn`) so the flow is provable without a daemon or a remote.
 *
 * Cancel arrives through the heartbeat reply (spec: "satu-satunya kanal
 * perintah") — when the control plane has marked the row `cancelled`, the
 * runner stops the sandbox via `turn.cancel()` and reports nothing (the row
 * is already cancelled; a `/result` for it would be 409).
 */
import { createLiteralRedactor, validatePipelineDefinition } from "@factory/shared";
import { stepRunBranchName } from "@factory/shared";
import { TurnCancelledError, type Turn, type TurnResult, type TurnSpec } from "./agent-runtime/index.js";
import type { GitOps } from "./git/ops.js";
import { LogBuffer, createLogSink, type LogChunkUploader, type LogSink } from "./log-buffer.js";
import { createProtocolLogChunkUploader } from "./log-uploader.js";
import type { ClaimedStepRun, ProtocolClient } from "./protocol/client.js";

export interface StepRunExecutorDeps {
  protocol: ProtocolClient;
  git: GitOps;
  /** The agent-runtime seam — the only way a sandbox turn happens. */
  startTurn: (spec: TurnSpec) => Turn;
  /** Where this Runner keeps its local clone for a repository. */
  repoDirFor: (owner: string, name: string) => string;
  /** Docker image for `docker`-mode turns. */
  sandboxImage: string;
  /** How often the executor heartbeats the in-flight lease (spec: 10s; tests inject a tiny value). */
  heartbeatIntervalMs?: number;
  /** Log chunk flush cadence (spec: 1s; tests inject a tiny value). */
  logFlushIntervalMs?: number;
  /** Log chunk size flush threshold (spec: 256 KiB; tests inject a tiny value). */
  logSizeFlushBytes?: number;
  /** Ring-buffer bound on pending log memory (spec: 64 MiB; tests inject a tiny value). */
  logRingBufferBytes?: number;
  /** Whole-log cap, truncated without failing the StepRun (spec: 256 MiB; tests inject a tiny value). */
  logCapBytes?: number;
  /** Overrides the per-StepRun chunk uploader — tests inject a recording fake so no network is touched. Defaults to the protocol-backed uploader. */
  logUploaderFor?: (claimed: ClaimedStepRun) => LogChunkUploader;
}

export interface ResolvedRunStep {
  run: string;
  runsOn: string[];
}

/** Parses the claimed definition and resolves this StepRun's Step. Throws for a definition this Runner cannot execute (agent Steps are a later issue's job). */
export function resolveStep(claimed: Pick<ClaimedStepRun, "id" | "definition" | "stepKey">): ResolvedRunStep {
  if (typeof claimed.definition !== "string") {
    throw new Error(`claimed step run ${claimed.id}: definition is not YAML text`);
  }
  const validation = validatePipelineDefinition(claimed.definition);
  if (!validation.valid) {
    throw new Error(`claimed step run ${claimed.id}: definition failed validation`);
  }
  const step = validation.pipeline.steps[claimed.stepKey];
  if (!step) {
    throw new Error(`claimed step run ${claimed.id}: no step '${claimed.stepKey}' in the definition`);
  }
  if (step.run === undefined) {
    throw new Error(
      `claimed step run ${claimed.id}: step '${claimed.stepKey}' is not a run: step (agent steps execute in a later issue)`,
    );
  }
  return { run: step.run, runsOn: step.runsOn ?? [] };
}

/** `exec:docker` is the default (spec: "exec:docker adalah bawaan"); `exec:host` is a per-Project opt-in (AC8) and selects the host provider. */
export function execModeFor(runsOn: string[]): "docker" | "host" {
  return runsOn.includes("exec:host") ? "host" : "docker";
}

function repoUrlFor(owner: string, name: string): string {
  return `https://github.com/${owner}/${name}.git`;
}

function perStepRunNetwork(stepRunId: string): string {
  return `factory-steprun-${stepRunId}`;
}

export const DEFAULT_LOG_FLUSH_INTERVAL_MS = 1000; // spec: "Runner flush tiap 1 detik"
export const DEFAULT_LOG_SIZE_FLUSH_BYTES = 256 * 1024; // spec: "atau 256 KiB"
export const DEFAULT_LOG_RING_BUFFER_BYTES = 64 * 1024 * 1024; // spec: "ring buffer 64 MiB"
export const DEFAULT_LOG_CAP_BYTES = 256 * 1024 * 1024; // spec: "batas 256 MiB"

/**
 * Builds the StepRun's live-log pipeline: literal-redaction over the git
 * tokens this turn holds, a `LogBuffer` bounded by the spec's ring/cap, and
 * a sink wired to the given uploader (spec: "Redaksi literal best-effort
 * sebelum upload"). Exposed so tests can construct buffers with tiny bounds
 * and a recording uploader.
 */
export function buildLogSink(
  uploader: LogChunkUploader,
  claimed: ClaimedStepRun,
  options: {
    flushIntervalMs?: number;
    sizeFlushBytes?: number;
    ringBufferBytes?: number;
    capBytes?: number;
  } = {},
): LogSink {
  const buffer = new LogBuffer({
    sizeFlushBytes: options.sizeFlushBytes ?? DEFAULT_LOG_SIZE_FLUSH_BYTES,
    ringBufferBytes: options.ringBufferBytes ?? DEFAULT_LOG_RING_BUFFER_BYTES,
    capBytes: options.capBytes ?? DEFAULT_LOG_CAP_BYTES,
    redact: createLiteralRedactor([claimed.gitTokens.fetch.token, claimed.gitTokens.push.token]),
  });
  return createLogSink(uploader, buffer, options.flushIntervalMs ?? DEFAULT_LOG_FLUSH_INTERVAL_MS);
}

export interface CancelWatch {
  stop(): void;
}

/** Heartbeat loop: renews the lease and turns `cancel` in the reply into `onCancel`. */
export function startCancelWatch(
  deps: Pick<StepRunExecutorDeps, "protocol" | "heartbeatIntervalMs">,
  claimed: Pick<ClaimedStepRun, "id" | "leaseToken">,
  onCancel: () => void,
): CancelWatch {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const intervalMs = deps.heartbeatIntervalMs ?? 10_000;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const reply = await deps.protocol.heartbeat({
        leases: [{ stepRunId: claimed.id, leaseToken: claimed.leaseToken }],
        capsHash: null,
      });
      if (reply.cancel.includes(claimed.id)) {
        onCancel();
      }
    } catch {
      // A failed heartbeat must not decide a turn's fate — the lease sweep is
      // the control plane's backstop for a Runner that stopped heartbeating.
    }
    if (!stopped) {
      timer = setTimeout(tick, intervalMs);
    }
  };

  timer = setTimeout(tick, intervalMs);
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

async function revokeTurnTokens(git: GitOps, claimed: ClaimedStepRun): Promise<void> {
  await Promise.allSettled([
    git.revokeInstallationToken(claimed.gitTokens.fetch.token),
    git.revokeInstallationToken(claimed.gitTokens.push.token),
  ]);
}

/**
 * Executes one already-claimed StepRun through the whole commit point.
 * Never throws for a turn-level outcome — failed commands, cancelled turns,
 * and even seam faults all end in either a `/result` POST or (for cancel) a
 * deliberate silence, with the tokens revoked either way.
 *
 * The live log is wired into the turn's `onLine` sink and flushed to Garage
 * (via presigned PUT) before the `/result` commits, so the archive is
 * complete the moment the StepRun ends. A failed final flush never blocks
 * or fails the StepRun — log capture is best-effort (spec: "Runner boleh
 * mati ... control plane tidak akan tahu — diterima").
 */
export async function executeClaimedTurn(deps: StepRunExecutorDeps, claimed: ClaimedStepRun): Promise<void> {
  const branch = stepRunBranchName({
    runId: claimed.runId as never,
    stepKey: claimed.stepKey,
    branchKey: claimed.branchKey,
    turn: claimed.turn,
    attempt: claimed.attempt,
  });
  const repoUrl = repoUrlFor(claimed.repository.owner, claimed.repository.name);
  const cloneDir = deps.repoDirFor(claimed.repository.owner, claimed.repository.name);
  const step = resolveStep(claimed);

  const uploader =
    deps.logUploaderFor?.(claimed) ??
    createProtocolLogChunkUploader({ protocol: deps.protocol }, claimed.id, claimed.leaseToken, claimed.attempt);
  const logSink = buildLogSink(uploader, claimed, {
    ...(deps.logFlushIntervalMs !== undefined ? { flushIntervalMs: deps.logFlushIntervalMs } : {}),
    ...(deps.logSizeFlushBytes !== undefined ? { sizeFlushBytes: deps.logSizeFlushBytes } : {}),
    ...(deps.logRingBufferBytes !== undefined ? { ringBufferBytes: deps.logRingBufferBytes } : {}),
    ...(deps.logCapBytes !== undefined ? { capBytes: deps.logCapBytes } : {}),
  });
  // Idempotent — the explicit calls before each /result run the final flush
  // while the lease is still valid, and the outer finally is the backstop
  // for the early-return (cancel) path.
  const stopLogging = () => logSink.stop().catch(() => {});

  try {
    await deps.git.ensureRepo(cloneDir, repoUrl);
    await deps.git.fetch(cloneDir, repoUrl, claimed.ref.sha, claimed.gitTokens.fetch.token);

    logSink.start();
    const turn = deps.startTurn({
      kind: "shell",
      command: step.run,
      workingDirectory: cloneDir,
      branch,
      baseRef: claimed.ref.sha,
      runsOn: execModeFor(step.runsOn),
      image: deps.sandboxImage,
      network: perStepRunNetwork(claimed.id),
      onLine: (line) => logSink.write(`${line}\n`),
      // AC5: the secrets resolved at /claim travel the seam to the agent call.
      secrets: claimed.secrets,
      // AC6: default-deny egress allowlist for the sandbox.
      egressAllowlist: claimed.egressAllowlist,
    });

    const cancelWatch = startCancelWatch(deps, claimed, () => turn.cancel());

    let result: TurnResult;
    try {
      result = await turn.done;
    } catch (error) {
      if (error instanceof TurnCancelledError) {
        await stopLogging();
        return; // the operator cancelled the row; it needs no /result.
      }
      await stopLogging();
      await deps.protocol.reportResult({
        stepRunId: claimed.id,
        leaseToken: claimed.leaseToken,
        outcome: "failed",
        reason: `turn fault: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    } finally {
      cancelWatch.stop();
    }

    if (result.exitCode !== 0) {
      await stopLogging();
      await deps.protocol.reportResult({
        stepRunId: claimed.id,
        leaseToken: claimed.leaseToken,
        outcome: "failed",
        reason: `run: command exited ${result.exitCode}`,
      });
      return;
    }

    let sha = claimed.ref.sha;
    if (result.preservedWorktreePath) {
      // The turn left changes behind: commit them on the named branch, then push.
      sha = await deps.git.commitAll(result.preservedWorktreePath, `factory: ${claimed.stepKey} (${branch})`);
    } else {
      // No uncommitted changes. The branch may still have been advanced by the
      // command itself; if not, push the base ref so the branch exists for the
      // next Step (the ref is the bus — it must exist).
      sha = await deps.git.refHead(cloneDir, branch).catch(() => sha);
    }

    // Push → final log flush → /result — the commit point order (AC2).
    await deps.git.push(cloneDir, repoUrl, sha, branch, claimed.gitTokens.push.token);
    await stopLogging();
    await deps.protocol.reportResult({
      stepRunId: claimed.id,
      leaseToken: claimed.leaseToken,
      outcome: "succeeded",
      ref: { branch, sha },
    });
  } finally {
    await stopLogging();
    await revokeTurnTokens(deps.git, claimed);
  }
}

/** Claims one StepRun and executes it. Returns `false` when nothing was claimable. */
export async function runOneCycle(
  deps: StepRunExecutorDeps,
  claimInput: { tags: string[]; slots: number; protocolVersion: number },
): Promise<boolean> {
  const claimed = await deps.protocol.claim(claimInput);
  if (!claimed) {
    return false;
  }
  await executeClaimedTurn(deps, claimed);
  return true;
}
