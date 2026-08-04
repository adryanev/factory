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
import path from "node:path";
import { writeFile, rm } from "node:fs/promises";
import {
  compileStepOutputContract,
  createLiteralRedactor,
  FACTORY_OUTPUT_TAG,
  generateId,
  renderFinalPrompt,
  resolveEffectiveStep,
  validatePipelineDefinition,
  type OutputsMap,
  type Question,
  type QuestionKind,
} from "@factory/shared";
import { stepRunBranchName } from "@factory/shared";
import { OutputInvalidError, TurnCancelledError, type Turn, type TurnResult, type TurnSpec } from "./agent-runtime/index.js";
import type { GitOps } from "./git/ops.js";
import { LogBuffer, createLogSink, type LogChunkUploader, type LogSink } from "./log-buffer.js";
import { createProtocolLogChunkUploader } from "./log-uploader.js";
import { createProtocolArtifactUploader, type ArtifactUploader, type UploadedArtifact } from "./artifact-uploader.js";
import type { Capabilities } from "./capabilities.js";
import type { ArtifactWire, ClaimedStepRun, ProtocolClient } from "./protocol/client.js";

export interface StepRunExecutorDeps {
  protocol: ProtocolClient;
  git: GitOps;
  /** The agent-runtime seam — the only way a sandbox turn happens. */
  startTurn: (spec: TurnSpec) => Turn;
  /** Where this Runner keeps its local clone for a repository. */
  repoDirFor: (owner: string, name: string) => string;
  /** Docker image for `docker`-mode turns. */
  sandboxImage: string;
  /** The Runner's probed capabilities — the source issue 9's maxRetries derivation reads (AC8). */
  capabilities: Pick<Capabilities, "agentClis">;
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
  /** Overrides the per-StepRun artifact uploader — tests inject a recording fake so no network is touched. Defaults to the protocol-backed uploader. */
  artifactUploaderFor?: (claimed: ClaimedStepRun) => ArtifactUploader;
}

/** A resolved Step the Runner can actually execute. */
export type ResolvedRunStep =
  | { kind: "shell"; run: string; runsOn: string[] }
  | {
      kind: "agent";
      agent: string;
      runsOn: string[];
      /** The final prompt — the Step's own prompt text plus the format-instruction block (AC4). */
      finalPrompt: string;
      outputs?: OutputsMap;
      ask?: { kind: QuestionKind };
    };

/**
 * Parses the claimed definition and resolves this StepRun's *effective*
 * Step. A fan-out branch (`branch_key` set) resolves to the fan-out Step
 * merged with its Branch's overrides via the shared `resolveEffectiveStep` —
 * the same resolution the control plane uses to pin the final prompt at
 * claim, so the two sides can never drift (issue #11). A `run:` Step yields
 * the shell branch; an agent Step (`prompt:`/`promptFile:`) is resolved with
 * the *final* prompt built from `outputs:` and `ask:` through the shared
 * `renderFinalPrompt` — the format-instruction block the Runner generates
 * (issue 9, AC4). Throws for a definition this Runner cannot execute.
 */
export function resolveStep(claimed: Pick<ClaimedStepRun, "id" | "definition" | "definitionFiles" | "stepKey" | "branchKey">): ResolvedRunStep {
  if (typeof claimed.definition !== "string") {
    throw new Error(`claimed step run ${claimed.id}: definition is not YAML text`);
  }
  const validation = validatePipelineDefinition(claimed.definition);
  if (!validation.valid) {
    throw new Error(`claimed step run ${claimed.id}: definition failed validation`);
  }
  const step = resolveEffectiveStep(validation.pipeline, claimed.stepKey, claimed.branchKey);
  if (!step) {
    throw new Error(`claimed step run ${claimed.id}: no step '${claimed.stepKey}' in the definition`);
  }
  if (step.run !== undefined) {
    return { kind: "shell", run: step.run, runsOn: step.runsOn ?? [] };
  }
  if (step.prompt !== undefined || step.promptFile !== undefined) {
    const basePrompt = step.promptFile
      ? (claimed.definitionFiles as Record<string, string> | undefined)?.[step.promptFile]
      : step.prompt;
    const contractSource = {
      ...(step.outputs !== undefined ? { outputs: step.outputs } : {}),
      ...(step.ask !== undefined ? { ask: step.ask } : {}),
    };
    return {
      kind: "agent",
      agent: step.agent ?? "claude",
      runsOn: step.runsOn ?? [],
      finalPrompt: renderFinalPrompt(basePrompt, contractSource),
      ...(step.outputs !== undefined ? { outputs: step.outputs } : {}),
      ...(step.ask !== undefined ? { ask: { kind: step.ask.kind } } : {}),
    };
  }
  throw new Error(
    `claimed step run ${claimed.id}: step '${claimed.stepKey}' is neither a run: step nor an agent step`,
  );
}

/** `exec:docker` is the default (spec: "exec:docker adalah bawaan"); `exec:host` is a per-Project opt-in (AC8) and selects the host provider. */
export function execModeFor(runsOn: string[]): "docker" | "host" {
  return runsOn.includes("exec:host") ? "host" : "docker";
}

/**
 * Agents whose sandcastle provider can resume a session (AC8) — the Runner's
 * `maxRetries` derivation reads this: a resumable agent gets 2, anything else
 * 0. `claude` and `codex` map to sandcastle's `claudeCode`/`codex` providers
 * (which carry `sessionStorage`); `cursor-agent` maps to `cursor()`, which
 * cannot resume — and sandcastle's `run()` fails at entry if a retry were
 * requested anyway (spec: "pemanggilan gagal di pintu masuk bila keduanya
 * tidak cocok").
 */
export const RESUMABLE_AGENTS = new Set(["claude", "codex"]);

/** AC8: `maxRetries` is never written in YAML — the Runner derives it from agent capabilities. */
export function deriveMaxRetries(
  capabilities: Pick<Capabilities, "agentClis">,
  agent: string,
): number {
  return capabilities.agentClis.includes(agent) && RESUMABLE_AGENTS.has(agent) ? 2 : 0;
}

/**
 * Extracts the single `<factory-output>` tag's JSON payload from a turn's
 * stdout. Returns `undefined` when the tag is absent or its content is not
 * JSON — the two "the agent did not produce usable Output" cases. The tag
 * name is the system constant, never typed by anyone (AC4); the JSON may be
 * fenced (```json … ```) the way agents often emit it.
 */
export function parseFactoryOutputTag(stdout: string): unknown {
  const open = `<${FACTORY_OUTPUT_TAG}>`;
  const close = `</${FACTORY_OUTPUT_TAG}>`;
  const start = stdout.indexOf(open);
  if (start === -1) return undefined;
  const contentStart = start + open.length;
  const end = stdout.indexOf(close, contentStart);
  const content = (end === -1 ? stdout.slice(contentStart) : stdout.slice(contentStart, end)).trim();
  const unwrapped = content
    .replace(/^```[a-zA-Z]*\s*\n?/, "")
    .replace(/\s*```$/, "")
    .replace(/^~~~[a-zA-Z]*\s*\n?/, "")
    .replace(/\s*~~~$/, "")
    .trim();
  try {
    return JSON.parse(unwrapped) as unknown;
  } catch {
    return undefined;
  }
}

export type ClassifiedAgentOutput =
  | { kind: "invalid" }
  | { kind: "question"; question: Question }
  | { kind: "done"; value: { kind: "done"; outputs: unknown } };

/**
 * Classifies the turn's Output against the step's discriminated union (the
 * one schema, from `@factory/shared` — AC6). Prefers the already-extracted
 * `TurnResult.output` (the real seam's `Output.object`), falling back to
 * parsing the tag from `stdout` (the seam-2 fake). A `question` becomes the
 * Question to POST; a `done` carries the outputs to forward downstream;
 * anything else — a missing tag, unparseable JSON, a schema violation — is
 * `invalid` and must end the turn as `failed` with `reason: output-invalid`.
 */
export function classifyAgentOutput(
  result: Pick<TurnResult, "stdout" | "output">,
  contract: ReturnType<typeof compileStepOutputContract>,
): ClassifiedAgentOutput {
  const candidate = result.output !== undefined ? result.output : parseFactoryOutputTag(result.stdout);
  if (candidate === undefined) {
    return { kind: "invalid" };
  }
  const parsed = contract.safeParse(candidate);
  if (!parsed.success) {
    return { kind: "invalid" };
  }
  const value = parsed.data as { kind: "question" | "done"; question?: unknown; outputs?: unknown };
  if (value.kind === "question") {
    return { kind: "question", question: value.question as Question };
  }
  return { kind: "done", value: value as { kind: "done"; outputs: unknown } };
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
 * Never throws for a turn-level outcome — failed commands, rejected Outputs,
 * cancelled turns, and even seam faults all end in either a `/result` POST,
 * a `/question` POST, or (for cancel) a deliberate silence, with the tokens
 * revoked either way.
 *
 * For an agent Step, the Output contract is compiled ONCE here, against the
 * same definition snapshot the control plane validates at `/result` (AC6) —
 * the Runner's pass is the live feedback while the session is still alive.
 * A rejected Output (`classifyAgentOutput` -> invalid, or the real seam's
 * `OutputInvalidError`) reports `failed` with `reason: output-invalid`; a
 * `question` Output posts a Question (the turn's other commit point, spec:
 * "push branch → … → POST Question"); a `done` Output flows downstream as
 * the turn's `output_data`.
 *
 * The live log is wired into the turn's `onLine` sink and flushed to Garage
 * (via presigned PUT) before the turn-ending POST commits, so the archive is
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

  // The Join manifest (issue #11, AC7): written to the host clone root so
  // the seam can carry it into the sandbox worktree as `.factory-manifest.json`,
  // cleaned up whatever happens. It is *not* the join Step's own git changes —
  // the manifest the branch already pushed is the work the turn commits.
  const manifestHostPath = path.join(cloneDir, ".factory-manifest.json");
  if (claimed.joinManifest.length > 0) {
    await writeFile(manifestHostPath, JSON.stringify(claimed.joinManifest, null, 2));
  }

  const uploader =
    deps.logUploaderFor?.(claimed) ??
    createProtocolLogChunkUploader({ protocol: deps.protocol }, claimed.id, claimed.leaseToken, claimed.attempt);
  const logSink = buildLogSink(uploader, claimed, {
    ...(deps.logFlushIntervalMs !== undefined ? { flushIntervalMs: deps.logFlushIntervalMs } : {}),
    ...(deps.logSizeFlushBytes !== undefined ? { sizeFlushBytes: deps.logSizeFlushBytes } : {}),
    ...(deps.logRingBufferBytes !== undefined ? { ringBufferBytes: deps.logRingBufferBytes } : {}),
    ...(deps.logCapBytes !== undefined ? { capBytes: deps.logCapBytes } : {}),
  });
  const artifactUploader =
    deps.artifactUploaderFor?.(claimed) ??
    createProtocolArtifactUploader({ protocol: deps.protocol }, claimed.id, claimed.leaseToken);
  // Idempotent — the explicit calls before each turn-ending POST run the final
  // flush while the lease is still valid, and the outer finally is the backstop
  // for the early-return (cancel) path.
  const stopLogging = () => logSink.stop().catch(() => {});
  // Best-effort: the manifest must never land on the branch the turn pushes.
  const removeManifestFromWorktree = (worktreePath: string | null) => {
    if (!worktreePath) return;
    return rm(path.join(worktreePath, ".factory-manifest.json"), { force: true }).catch(() => {});
  };

  try {
    await deps.git.ensureRepo(cloneDir, repoUrl);
    await deps.git.fetch(cloneDir, repoUrl, claimed.ref.sha, claimed.gitTokens.fetch.token);

    logSink.start();
    const turn = deps.startTurn(turnSpecFor(deps, claimed, step, branch, (line) => logSink.write(`${line}\n`)));

    const cancelWatch = startCancelWatch(deps, claimed, () => turn.cancel());

    let result: TurnResult;
    try {
      result = await turn.done;
    } catch (error) {
      if (error instanceof TurnCancelledError) {
        await stopLogging();
        return; // the operator cancelled the row; it needs no /result.
      }
      if (step.kind === "agent" && error instanceof OutputInvalidError) {
        // The real seam's Output.object exhausted its resume attempts — the
        // Output was rejected, exactly like the fake's stdout parse would be.
        await stopLogging();
        await deps.protocol.reportResult({
          stepRunId: claimed.id,
          leaseToken: claimed.leaseToken,
          outcome: "failed",
          reason: "output-invalid",
        });
        return;
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

    if (step.kind === "shell") {
      if (result.exitCode !== 0) {
        await stopLogging();
        await removeManifestFromWorktree(result.preservedWorktreePath);
        await deps.protocol.reportResult({
          stepRunId: claimed.id,
          leaseToken: claimed.leaseToken,
          outcome: "failed",
          reason: `run: command exited ${result.exitCode}`,
        });
        return;
      }
      await removeManifestFromWorktree(result.preservedWorktreePath);
      const sha = await commitAndPush(deps, claimed, cloneDir, repoUrl, branch, result);
      await stopLogging();
      // The turn's diff is materialized as an artifact after the push, before
      // the turn-ending POST (AC6: "Diff dimaterialisasi jadi blob saat
      // StepRun berakhir, sehingga branch bebas dihapus").
      const artifacts = await materializeDiff(deps, artifactUploader, claimed, cloneDir, sha);
      await deps.protocol.reportResult({
        stepRunId: claimed.id,
        leaseToken: claimed.leaseToken,
        outcome: "succeeded",
        ref: { branch, sha },
        ...(artifacts.length > 0 ? { artifacts } : {}),
      });
      return;
    }

    // --- agent Step --------------------------------------------------------
    // The branch is the bus: it is pushed as part of the turn's commit point
    // *before* the Output is classified, so a `done` flows downstream, a
    // `question` is posted with the ref, and an invalid Output still leaves
    // the branch behind — an orphan for the retention GC (AC7: "branch yang
    // telanjur ada jadi yatim untuk GC").
    const contract = compileStepOutputContract({
      ...(step.outputs !== undefined ? { outputs: step.outputs } : {}),
      ...(step.ask !== undefined ? { ask: step.ask } : {}),
    });
    await removeManifestFromWorktree(result.preservedWorktreePath);
    const sha = await commitAndPush(deps, claimed, cloneDir, repoUrl, branch, result);
    await stopLogging();

    const classified = classifyAgentOutput(result, contract);
    if (classified.kind === "invalid") {
      await deps.protocol.reportResult({
        stepRunId: claimed.id,
        leaseToken: claimed.leaseToken,
        outcome: "failed",
        reason: "output-invalid",
        ref: { branch, sha },
      });
      return;
    }

    if (classified.kind === "question") {
      if (claimed.askGroupId === null) {
        await deps.protocol.reportResult({
          stepRunId: claimed.id,
          leaseToken: claimed.leaseToken,
          outcome: "failed",
          reason: "ask-group-unresolved",
          ref: { branch, sha },
        });
        return;
      }
      await deps.protocol.submitQuestion({
        stepRunId: claimed.id,
        leaseToken: claimed.leaseToken,
        question: {
          id: generateId("question"),
          groupId: claimed.askGroupId,
          kind: classified.question.kind,
          body: classified.question.body,
          ...(classified.question.kind === "choice"
            ? {
                options: classified.question.options.map((option) => ({
                  id: option.id,
                  label: option.label,
                  ...(option.description !== undefined ? { description: option.description } : {}),
                })),
                multi: classified.question.multi,
                allowOther: classified.question.allowOther,
              }
            : {}),
          ...(classified.question.kind === "edit-artifact"
            ? { artifactKey: classified.question.artifactKey }
            : {}),
        },
        ref: { branch, sha },
      });
      return;
    }

    // The turn's diff is materialized as an artifact after the push, before
    // the turn-ending POST (AC6) — only for a `done` turn; a question posts
    // the branch onward and an invalid Output makes the whole turn void.
    const uploadedDiffArtifacts = await materializeDiff(deps, artifactUploader, claimed, cloneDir, sha);
    await deps.protocol.reportResult({
      stepRunId: claimed.id,
      leaseToken: claimed.leaseToken,
      outcome: "succeeded",
      ref: { branch, sha },
      outputData: classified.value,
      ...(uploadedDiffArtifacts.length > 0 ? { artifacts: uploadedDiffArtifacts } : {}),
    });
  } finally {
    await stopLogging();
    await rm(manifestHostPath, { force: true }).catch(() => {});
    await revokeTurnTokens(deps.git, claimed);
  }
}

/**
 * Materializes the turn's diff — the pushed branch vs the base ref — as an
 * artifact, so the branch can be deleted without the change being lost
 * (spec: "Diff dimaterialisasi jadi blob saat StepRun berakhir, sehingga
 * branch bebas dihapus"). Called only on a `succeeded` /result: a failed
 * turn's whole turn "seolah tidak pernah terjadi", and its orphan branch is
 * the retention GC's to reap.
 *
 * Best-effort by design (AC5): a failed `git diff` or a failed upload yields
 * nothing to ride `/result` — the StepRun is unaffected either way. The blob
 * is uploaded before the metadata rides `/result`, preserving "baris Artifact
 * ada ⇒ blob pasti ada".
 */
async function materializeDiff(
  deps: Pick<StepRunExecutorDeps, "git">,
  uploader: ArtifactUploader,
  claimed: ClaimedStepRun,
  cloneDir: string,
  headSha: string,
): Promise<ArtifactWire[]> {
  let diffText: string;
  try {
    diffText = await deps.git.diff(cloneDir, claimed.ref.sha, headSha);
  } catch {
    return [];
  }
  const uploaded = await uploader.uploadArtifacts([
    { key: "diff", kind: "diff", contentType: "text/x-diff", text: diffText },
  ]);
  return uploaded.map((artifact) => ({
    key: artifact.key,
    kind: artifact.kind,
    contentType: artifact.contentType,
    sizeBytes: artifact.sizeBytes,
  }));
}

/** The relative name the manifest file rides into the sandbox worktree under (see `agent-runtime/runtime.ts`). */
const MANIFEST_WORKTREE_NAME = ".factory-manifest.json";

/** Builds the seam spec for the resolved Step — shell or agent (issue 9). */
function turnSpecFor(
  deps: StepRunExecutorDeps,
  claimed: ClaimedStepRun,
  step: ResolvedRunStep,
  branch: string,
  onLine: (line: string) => void,
): TurnSpec {
  const common = {
    workingDirectory: deps.repoDirFor(claimed.repository.owner, claimed.repository.name),
    branch,
    baseRef: claimed.ref.sha,
    runsOn: execModeFor(step.runsOn),
    image: deps.sandboxImage,
    network: perStepRunNetwork(claimed.id),
    onLine,
    // AC5: the secrets resolved at /claim travel the seam to the agent call.
    secrets: claimed.secrets,
    // AC6: default-deny egress allowlist for the sandbox.
    egressAllowlist: claimed.egressAllowlist,
    // The Join manifest (issue #11, AC7), when this StepRun joins a fan-out.
    ...(claimed.joinManifest.length > 0
      ? { manifestFile: path.join(deps.repoDirFor(claimed.repository.owner, claimed.repository.name), ".factory-manifest.json") }
      : {}),
  };
  if (step.kind === "shell") {
    return { kind: "shell", command: step.run, ...common };
  }
  const manifestNote =
    claimed.joinManifest.length > 0
      ? `\n\nA manifest of the upstream branches you are joining is available at ${MANIFEST_WORKTREE_NAME} in your working directory: [{ key, repo, branch, sha, outcome, outputs }]. Read it to see every branch's outcome and structured output.`
      : "";
  return {
    kind: "agent",
    agent: step.agent,
    prompt: `${step.finalPrompt}${manifestNote}`,
    outputContract: compileStepOutputContract({
      ...(step.outputs !== undefined ? { outputs: step.outputs } : {}),
      ...(step.ask !== undefined ? { ask: step.ask } : {}),
    }),
    // AC8: maxRetries is derived from agent capabilities, never written in YAML.
    maxRetries: deriveMaxRetries(deps.capabilities, step.agent),
    ...common,
  };
}

/** Commits whatever the turn left behind (if anything) and pushes the named branch — the ref is the bus, it must exist before any turn-ending POST (AC2). */
async function commitAndPush(
  deps: StepRunExecutorDeps,
  claimed: ClaimedStepRun,
  cloneDir: string,
  repoUrl: string,
  branch: string,
  result: TurnResult,
): Promise<string> {
  let sha = claimed.ref.sha;
  if (result.preservedWorktreePath) {
    // The turn left changes behind: commit them on the named branch, then push.
    sha = await deps.git.commitAll(result.preservedWorktreePath, `factory: ${claimed.stepKey} (${branch})`);
  } else {
    // No uncommitted changes. The branch may still have been advanced by the
    // turn itself; if not, push the base ref so the branch exists for the
    // next Step (the ref is the bus — it must exist).
    sha = await deps.git.refHead(cloneDir, branch).catch(() => sha);
  }
  await deps.git.push(cloneDir, repoUrl, sha, branch, claimed.gitTokens.push.token);
  return sha;
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
