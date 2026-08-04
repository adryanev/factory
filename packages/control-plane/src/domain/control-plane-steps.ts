/**
 * The control plane as a lessee: `kind: pull-request` StepRuns are claimed
 * and executed by the control plane itself (issue #17). Everything here is
 * deliberately *not* a second mechanism — the shared `claim_step_run.sql`
 * runs with the control-plane instance as `$1` (lessee), a `'pull-request'`
 * `wanted_kind`, a **60-second lease with no heartbeat**, and the existing
 * lease sweep reaps a hanging one exactly as it reaps a Runner's (ticket 24:
 * "Ini satu-satunya mekanisme yang menjawab 'siapa yang mendeteksi control
 * plane mati di tengah', dan biayanya nol kode baru").
 *
 * The numbers are owned by the kind, not the author (AC2): `timeout: 60s`
 * (the lease — one GitHub call round, not the whole Step), `attempts: 3`
 * (the internal retry loop, below), backoff 5s fixed unless GitHub sends
 * `Retry-After`, which is honored verbatim. The schema rejects author-written
 * `timeout:`/`attempts:` on a kind: Step.
 *
 * Idempotency leans entirely on GitHub (AC6): find the open PR for the
 * head/base pair and **adopt** it; a `POST /pulls` that returns 422 ("a pull
 * request already exists") is treated as success and the PR is re-found. The
 * boundary is documented in the spec: a PR a human already closed yields a
 * new PR, and that is correct — the only harmful duplicate, two *open* PRs
 * from one branch, is exactly what GitHub's constraint prevents.
 *
 * Cancel (AC9): the Run's cancel flag is checked immediately before the one
 * write call (`POST /pulls`). A StepRun that was never claimed never starts;
 * one claimed but not yet writing stops there; one that already wrote is
 * left to finish — recording the PR is better than opening one we never
 * noted. The residual window (cancel arriving in the milliseconds between
 * the check and GitHub's response) is documented in the module doc: a PR may
 * land on a Run that ends cancelled, which the UI shows honestly.
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  resolveEffectiveStep,
  type Id,
  type Pipeline,
} from "@factory/shared";
import { githubAppInstallations, repositories, runs, stepRuns } from "../db/schema.js";
import type { AppDeps } from "../deps.js";
import { loadSqlStatement } from "../db/sql/load.js";
import {
  GithubRequestError,
  PULL_REQUEST_WRITE_PERMISSIONS,
  PullRequestConflictError,
  type PullRequest,
  type RepoRef,
} from "./git-host.js";
import { advanceGraph, finalizeRunIfDone, parsePipelineSnapshot, structuredOutputs, type RunRow } from "./graph-advance.js";

const CLAIM_QUERY = loadSqlStatement("claim_step_run.sql");

/** The kind's lease: 60 seconds, no heartbeat (ticket 24, AC1). */
export const CONTROL_PLANE_LEASE_SECONDS = 60;
/** The kind's retry ceiling: 3 attempts per claim (ticket 24, AC2). */
export const PULL_REQUEST_ATTEMPTS = 3;
/** Backoff when GitHub does not say Retry-After (ticket 24, AC2). */
export const PULL_REQUEST_RETRY_BACKOFF_MS = 5000;
/** How many `kind:` StepRuns this instance may hold at once — the claim query's slots fence. */
export const CONTROL_PLANE_CLAIM_SLOTS = 4;
/** Poll cadence when nothing is claimable. */
export const CONTROL_PLANE_CLAIM_POLL_MS = 1000;
/** The Commit Status context — what shows in the PR's checks area. */
export const COMMIT_STATUS_CONTEXT = "factory";

/** The world the executor reaches into — a strict subset of `AppDeps`. */
export type ControlPlaneStepDeps = Pick<
  AppDeps,
  "pool" | "db" | "gitHost" | "clock" | "controlPlaneInstanceId" | "runPageBaseUrl"
>;

interface ClaimedControlPlaneRow {
  id: Id<"steprun">;
  run_id: Id<"run">;
  repository_id: Id<"repository">;
  step_key: string;
  branch_key: string | null;
  turn: number;
  attempt: number;
  lease_token: string;
  lease_expires_at: Date;
}

interface HydratedClaim {
  row: ClaimedControlPlaneRow;
  run: RunRow;
  repository: typeof repositories.$inferSelect;
  installationId: number;
  /** The parsed definition snapshot, when usable — null means "cannot execute, mark failed". */
  pipeline: Pipeline | null;
  step: Pipeline["steps"][string] | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The backoff after a failed GitHub call: `Retry-After` verbatim when GitHub
 * sent one (AC2: "patuhi `Retry-After`"), else the kind's fixed 5s. Pure —
 * extracted so the Retry-After precedence is provable without sleeping.
 */
export function retryBackoffMs(error: unknown, fixedBackoffMs: number): number {
  if (error instanceof GithubRequestError && error.retryAfterSeconds !== null) {
    return error.retryAfterSeconds * 1000;
  }
  return fixedBackoffMs;
}

/** Executor options — tests inject a tiny backoff so transient-failure tests finish in milliseconds. */
export interface ControlPlaneStepOptions {
  retryBackoffMs?: number;
}

/** The latest row of one StepRun of a Run — optionally narrowed to a branch. */
async function latestStepRunRow(
  deps: ControlPlaneStepDeps,
  runId: Id<"run">,
  stepKey: string,
  branchKey: string | null,
): Promise<typeof stepRuns.$inferSelect | undefined> {
  const rows = await deps.db
    .select()
    .from(stepRuns)
    .where(
      and(
        eq(stepRuns.runId, runId),
        eq(stepRuns.stepKey, stepKey),
        branchKey === null ? isNull(stepRuns.branchKey) : eq(stepRuns.branchKey, branchKey),
      ),
    )
    .orderBy(desc(stepRuns.turn));
  return rows[0];
}

/** Runs the shared claim query once, lessee = this control-plane instance. */
async function claimControlPlaneStepRun(
  deps: ControlPlaneStepDeps,
): Promise<ClaimedControlPlaneRow | null> {
  const result = await deps.pool.query<ClaimedControlPlaneRow>(CLAIM_QUERY, [
    deps.controlPlaneInstanceId,
    [], // control-plane Steps have no runsOn — no tags to match.
    CONTROL_PLANE_CLAIM_SLOTS,
    CONTROL_PLANE_LEASE_SECONDS,
    "pull-request",
  ]);
  return result.rows[0] ?? null;
}

/** Hydrates the claimed row: the run, its repository, the installation, and the effective Step. */
async function hydrateClaimed(
  deps: ControlPlaneStepDeps,
  row: ClaimedControlPlaneRow,
): Promise<HydratedClaim> {
  const [run] = await deps.db.select().from(runs).where(eq(runs.id, row.run_id));
  const [repository] = await deps.db.select().from(repositories).where(eq(repositories.id, row.repository_id));
  if (!run || !repository) {
    // Foreign keys the claim query guarantees NOT NULL — absence means the
    // database itself is inconsistent.
    throw new Error(`claimed control-plane step run ${row.id} references a missing run or repository`);
  }
  const [installation] = await deps.db
    .select()
    .from(githubAppInstallations)
    .where(eq(githubAppInstallations.id, repository.githubAppInstallationId));
  if (!installation) {
    throw new Error(`repository ${repository.id} references a missing github app installation`);
  }
  const pipeline = parsePipelineSnapshot(run.definition);
  const step = pipeline
    ? resolveEffectiveStep(pipeline, row.step_key, row.branch_key) ?? null
    : null;
  return { row, run, repository, installationId: installation.installationId, pipeline, step };
}

/**
 * The head ref the PR opens from: the branch (and its SHA) the `after:` Step
 * produced. For a per-branch PR (`branch_key` set) that is the matching
 * fan-out branch's output ref; for a once-PR (`branch_key` null) the plain
 * `after:` Step's output ref. The commit status is posted to this SHA.
 */
async function resolveHeadRef(
  deps: ControlPlaneStepDeps,
  claimed: HydratedClaim,
): Promise<{ branch: string; sha: string } | null> {
  const depKey = claimed.step!.after[0]!;
  const upstream = await latestStepRunRow(deps, claimed.run.id, depKey, claimed.row.branch_key);
  if (!upstream || upstream.outcome !== "succeeded" || !upstream.outputRefBranch || !upstream.outputRefSha) {
    return null;
  }
  return { branch: upstream.outputRefBranch, sha: upstream.outputRefSha };
}

/**
 * The value of a `{ step, output }` reference at the PR's branch context —
 * used for `title:` and `body:`. A fan-out source resolves to the branch
 * this PR is born for (matching `branch_key`); anything else to the plain
 * row. The schema already guaranteed the output exists and is `type: string`;
 * this is where its *value* is read out of the /result gate's envelope.
 */
async function resolveOutputValue(
  deps: ControlPlaneStepDeps,
  claimed: HydratedClaim,
  ref: { step: string; output: string },
): Promise<string | null> {
  const source = claimed.pipeline!.steps[ref.step]!;
  const branchKey =
    (source.branches !== undefined || source.branchesFrom !== undefined) && claimed.row.branch_key !== null
      ? claimed.row.branch_key
      : null;
  const row = await latestStepRunRow(deps, claimed.run.id, ref.step, branchKey);
  const outputs = structuredOutputs(row?.outputData);
  const value =
    typeof outputs === "object" && outputs !== null && ref.output in outputs
      ? (outputs as Record<string, unknown>)[ref.output]
      : undefined;
  return typeof value === "string" ? value : null;
}

/** True when the operator cancelled the Run or the StepRun while we executed. */
async function isCancelled(deps: ControlPlaneStepDeps, claimed: HydratedClaim): Promise<boolean> {
  const [row] = await deps.db.select().from(stepRuns).where(eq(stepRuns.id, claimed.row.id));
  if (row?.outcome === "cancelled") return true;
  return claimed.run.cancelRequestedAt !== null;
}

/** The StepRun's terminal commit — the row update plus the Graph advance it triggers, one transaction (the same shape /result uses). The lease is cleared: a terminal row must not keep counting against `claim_step_run.sql`'s `count(*) < slots` fence (the executor runs cycles back-to-back, so an uncleared lease would fence the instance out for the lease's whole lifetime). */
async function commitKindOutcome(
  deps: ControlPlaneStepDeps,
  claimed: HydratedClaim,
  outcome: "succeeded" | "failed" | "cancelled",
  patch: { reason?: string | null; prNumber?: number | null; prUrl?: string | null } = {},
): Promise<void> {
  const { row, run, pipeline } = claimed;
  await deps.db.transaction(async (tx) => {
    await tx
      .update(stepRuns)
      .set({
        outcome,
        leasedBy: null,
        leaseToken: null,
        leaseExpiresAt: null,
        ...(patch.reason !== undefined ? { reason: patch.reason } : {}),
        ...(patch.prNumber !== undefined ? { prNumber: patch.prNumber } : {}),
        ...(patch.prUrl !== undefined ? { prUrl: patch.prUrl } : {}),
      })
      .where(eq(stepRuns.id, row.id));
    if (pipeline) {
      await advanceGraph({ db: tx, now: deps.clock.now }, run, pipeline, row.step_key);
      await finalizeRunIfDone({ db: tx, now: deps.clock.now }, run.id, pipeline);
    }
  });
}

/**
 * Executes one already-claimed `kind: pull-request` StepRun: mint the narrow
 * token, find-or-create the PR, post the Commit Status, and commit the
 * terminal row. Never throws for a GitHub-level outcome — retries, adoption,
 * and the failure commit are all handled here. Throws only when the claimed
 * row is so inconsistent it cannot be executed (a control-plane bug).
 */
export async function executePullRequestStep(
  deps: ControlPlaneStepDeps,
  claimed: HydratedClaim,
  options: ControlPlaneStepOptions = {},
): Promise<void> {
  const { row, run, repository, pipeline, step } = claimed;

  if (step === null || pipeline === null || step.kind !== "pull-request") {
    await commitKindOutcome(deps, claimed, "failed", { reason: "control-plane-step-unresolved" });
    return;
  }

  const headRef = await resolveHeadRef(deps, claimed);
  if (headRef === null) {
    await commitKindOutcome(deps, claimed, "failed", { reason: "head-ref-unresolved" });
    return;
  }
  const title = await resolveOutputValue(deps, claimed, step.title!);
  const body = await resolveOutputValue(deps, claimed, step.body!);
  if (title === null || body === null) {
    await commitKindOutcome(deps, claimed, "failed", { reason: "pr-title-body-unresolved" });
    return;
  }

  const repo: RepoRef = { owner: repository.owner, name: repository.name };
  const base = step.base ?? repository.defaultBranch;
  const token = await deps.gitHost.mintInstallationToken(repo, claimed.installationId, PULL_REQUEST_WRITE_PERMISSIONS);
  const runPageUrl = `${deps.runPageBaseUrl}/runs/${run.id}`;

  const commitStatus = {
    state: "success" as const,
    context: COMMIT_STATUS_CONTEXT,
    description: `factory opened a pull request — see the run`,
    targetUrl: runPageUrl,
  };

  let lastError: Error | null = null;
  let pr: PullRequest | null = null;
  for (let attempt = 1; attempt <= PULL_REQUEST_ATTEMPTS; attempt += 1) {
    try {
      // Idempotency half one (AC6): search the open PR for this head/base
      // pair and adopt it — a retried attempt after a crash lands here.
      pr = await deps.gitHost.findOpenPullRequest(repo, headRef.branch, base, token.token);
      if (pr === null) {
        // AC9: cancel checked immediately before the write call. Once the
        // create has been issued the attempt is left to finish — opening a PR
        // and then abandoning it is worse than recording it.
        if (await isCancelled(deps, claimed)) {
          await commitKindOutcome(deps, claimed, "cancelled", { reason: "cancelled-by-operator" });
          return;
        }
        try {
          pr = await deps.gitHost.createPullRequest(repo, { title, body, head: headRef.branch, base }, token.token);
        } catch (error) {
          if (!(error instanceof PullRequestConflictError)) throw error;
          // Idempotency half two: a raced create that GitHub refused with 422
          // is success-by-adoption — re-find to get the number. A 422 that
          // does not resolve to a real PR (some other validation failure) is a
          // genuine failure and falls out of the loop's retry.
          pr = await deps.gitHost.findOpenPullRequest(repo, headRef.branch, base, token.token);
          if (pr === null) {
            throw new Error("github pull request create returned 422 but no matching open pull request was found");
          }
        }
      }
      // The status is posted to the PR's head commit — the one the checks
      // area reads (AC7, `target_url` -> Run page). Checks API rejected.
      await deps.gitHost.postCommitStatus(repo, pr.headSha, commitStatus, token.token);
      break;
    } catch (error) {
      lastError = error as Error;
      if (attempt < PULL_REQUEST_ATTEMPTS) {
        await sleep(retryBackoffMs(error, options.retryBackoffMs ?? PULL_REQUEST_RETRY_BACKOFF_MS));
      }
    }
  }

  if (pr === null) {
    // The reason is the only diagnostic a failed control-plane StepRun has —
    // the GitHub response body, stored verbatim (ticket 24: "body respons
    // GitHub disimpan sebagai reason StepRun").
    await commitKindOutcome(deps, claimed, "failed", {
      reason: lastError ? lastError.message : "github-write-failed",
    });
    return;
  }

  await commitKindOutcome(deps, claimed, "succeeded", {
    prNumber: pr.number,
    prUrl: pr.htmlUrl,
  });
}

/**
 * One control-plane executor cycle: claim a `kind:` StepRun (or none), run
 * it, and commit its outcome. Returns `true` when it claimed and executed a
 * StepRun — the caller can immediately loop for more.
 */
export async function runControlPlaneStepCycle(
  deps: ControlPlaneStepDeps,
  options: ControlPlaneStepOptions = {},
): Promise<boolean> {
  const row = await claimControlPlaneStepRun(deps);
  if (!row) {
    return false;
  }
  const claimed = await hydrateClaimed(deps, row);
  try {
    await executePullRequestStep(deps, claimed, options);
  } catch (error) {
    // A control-plane inconsistency (missing rows, unusable definition) —
    // record it as a failed StepRun rather than letting the sweep retry a
    // row that can never succeed.
    await commitKindOutcome(deps, claimed, "failed", {
      reason: `control-plane fault: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  return true;
}

export interface ControlPlaneStepExecutorHandle {
  stop(): void;
}

/**
 * The production background loop: claims and executes `kind:` StepRuns as
 * fast as they appear, polling `claim_step_run.sql` every second when there
 * is nothing to do (the same 1s poll the Runner /claim uses). Started by
 * `main.ts` after the listener opens; tests drive `runControlPlaneStepCycle`
 * directly instead.
 */
export function startControlPlaneStepExecutor(
  deps: ControlPlaneStepDeps,
  pollMs: number = CONTROL_PLANE_CLAIM_POLL_MS,
): ControlPlaneStepExecutorHandle {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cycle = async (): Promise<void> => {
    if (stopped) return;
    try {
      if (await runControlPlaneStepCycle(deps)) {
        // Work done — try again immediately instead of sleeping through a
        // poll gap.
        void cycle();
        return;
      }
    } catch (error) {
      // The loop must never die from a transient DB/network fault — the
      // claim row (if any) was already leased and the sweep will reap it.
      console.error("control-plane step executor cycle failed", error);
    }
    if (!stopped) {
      timer = setTimeout(() => void cycle(), pollMs);
    }
  };

  timer = setTimeout(() => void cycle(), 0);
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
