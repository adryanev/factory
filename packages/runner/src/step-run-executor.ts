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
import { validatePipelineDefinition } from "@factory/shared";
import { stepRunBranchName } from "@factory/shared";
import { TurnCancelledError, type Turn, type TurnResult, type TurnSpec } from "./agent-runtime/index.js";
import type { GitOps } from "./git/ops.js";
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

  try {
    await deps.git.ensureRepo(cloneDir, repoUrl);
    await deps.git.fetch(cloneDir, repoUrl, claimed.ref.sha, claimed.gitTokens.fetch.token);

    const turn = deps.startTurn({
      kind: "shell",
      command: step.run,
      workingDirectory: cloneDir,
      branch,
      baseRef: claimed.ref.sha,
      runsOn: execModeFor(step.runsOn),
      image: deps.sandboxImage,
      network: perStepRunNetwork(claimed.id),
    });

    const cancelWatch = startCancelWatch(deps, claimed, () => turn.cancel());

    let result: TurnResult;
    try {
      result = await turn.done;
    } catch (error) {
      if (error instanceof TurnCancelledError) {
        return; // the operator cancelled the row; it needs no /result.
      }
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

    // Push → /result — the commit point order (AC2).
    await deps.git.push(cloneDir, repoUrl, sha, branch, claimed.gitTokens.push.token);
    await deps.protocol.reportResult({
      stepRunId: claimed.id,
      leaseToken: claimed.leaseToken,
      outcome: "succeeded",
      ref: { branch, sha },
    });
  } finally {
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
