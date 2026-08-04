/**
 * `/claim`: long-poll wrapper around the hand-written `claim_step_run.sql`
 * (spec: "Kueri klaim ... FOR UPDATE SKIP LOCKED ... contract test langsung
 * ke Postgres di bawah klaim serentak" — that contract test already proves
 * the query itself; this file only adds the long-poll shell and the
 * response shape around it, and must not re-derive any of the query's own
 * guarantees).
 *
 * "Implementasi tahan = poll kueri klaim tiap 1 detik per koneksi
 * menggantung" (spec) — this is deliberately not `LISTEN/NOTIFY` (explicitly
 * deferred in "Out of Scope": "aturan 'ukur sebelum optimasi' menahannya").
 */
import { and, eq } from "drizzle-orm";
import {
  isProtocolVersionSupported,
  renderFinalPrompt,
  resolveEffectiveStep,
  validatePipelineDefinition,
  type Id,
  type JoinManifest,
} from "@factory/shared";
import { githubAppInstallations, groups, projects, repositories, runs, stepRuns } from "../db/schema.js";
import type { AppDeps } from "../deps.js";
import { loadSqlStatement } from "../db/sql/load.js";
import { ProtocolVersionError } from "./errors.js";
import type { InstallationToken, RepoRef } from "./git-host.js";
import type { RunnerIdentity } from "./runners.js";
import { resolveSecretsForPrincipal } from "./secrets.js";
import { buildJoinManifest, type RunRow } from "./graph-advance.js";

const CLAIM_QUERY = loadSqlStatement("claim_step_run.sql");
const POLL_INTERVAL_MS = 1000; // spec: "poll kueri klaim tiap 1 detik per koneksi menggantung"

interface ClaimedRow {
  id: Id<"steprun">;
  run_id: Id<"run">;
  repository_id: Id<"repository">;
  step_key: string;
  branch_key: string | null;
  turn: number;
  attempt: number;
  lease_token: string;
  lease_expires_at: Date;
  // The conversation carries across turns via the blob store (issue 13): the
  // ref the previous turn pushed becomes this turn's base, and the session
  // (blob + id) is handed to the Runner so the agent resumes from the same
  // context on any free machine.
  output_ref_branch: string | null;
  output_ref_sha: string | null;
  session_blob_key: string | null;
  session_id: string | null;
  resume_prompt: string | null;
}

export interface ClaimedStepRun {
  id: Id<"steprun">;
  runId: Id<"run">;
  stepKey: string;
  branchKey: string | null;
  turn: number;
  attempt: number;
  repository: { id: Id<"repository">; owner: string; name: string; defaultBranch: string };
  ref: { branch: string; sha: string };
  definition: unknown;
  definitionFiles: unknown;
  leaseToken: string;
  leaseExpiresAt: Date;
  /**
   * The two 1-hour installation tokens minted for this turn (spec: "token
   * repo per-StepRun ikut di muatan /claim"; ticket 10: "mint dua kali per
   * giliran"). `fetch` narrows to the Repository and is used by the Runner
   * to fetch the base ref; `push` — a second, separately-scoped token — is
   * what the Runner pushes the named branch with. Both are `contents: write`
   * only; teardown revocation ("dihapus saat teardown") is the Runner's own
   * job — it holds the tokens and `DELETE /installation/token` authenticates
   * with the token itself, so no App credential ever leaves the control
   * plane (see `packages/runner`'s step-run executor).
   */
  gitTokens: { fetch: InstallationToken; push: InstallationToken };
  /**
   * The secrets resolved at scheduling time (spec: "secret di-resolve saat
   * penjadwalan") for the Run's `credentialPrincipalId` — a `name -> value`
   * map handed directly to the Runner, which passes it to the agent call.
   * The values are decrypted here, in the control plane, and carried only in
   * this payload: never written to a file inside the sandbox (AC5).
   */
  secrets: Record<string, string>;
  /**
   * The Project's default-deny egress allowlist. The Runner turns this into
   * firewall rules scoped to the agent's OS user; hosts outside it get no
   * egress (AC6).
   */
  egressAllowlist: string[];
  /**
   * The id of the Group an interactive Step's `ask:` addresses, resolved by
   * the control plane at claim time (spec: "Runner tidak pernah menanyakan
   * apa pun tentang dunia; semua yang ia butuh ikut di muatan /claim"). Null
   * for non-interactive Steps — and for an interactive Step whose `ask.group`
   * names no Group of this Project, in which case the Runner's Question POST
   * will be refused at the door.
   */
  askGroupId: Id<"group"> | null;
  /**
   * The previous turn's session, when this is a resumed turn (issue 13, AC2):
   * the blob the Runner must download and hand to the agent's `resumeSession`.
   * Null for a fresh turn. The `getUrl` is a 5-minute presigned GET minted at
   * claim — the Runner fetches the bytes straight from the object store.
   */
  session: { id: string; blobKey: string; getUrl: string; expiresAt: Date } | null;
  /**
   * The Join manifest (issue #11, AC7): one entry per branch of every
   * fan-out Step this StepRun joins (`[{ key, repo, branch, sha, outcome,
   * outputs }]`), so a Join Step reads its upstream branches as data and
   * fetches only the branches sharing its own repo — cross-repo branches are
   * reads, never checkouts (ticket 21). Empty for a Step that joins nothing.
   */
  joinManifest: JoinManifest;
}

export interface ClaimInput {
  tags: string[];
  slots: number;
  protocolVersion: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs `claim_step_run.sql` once. `wantedKind: null` — this issue only claims ordinary Runner-facing StepRuns; `kind: 'pull-request'` claiming (lessee = a control-plane instance) belongs to issue 24, out of this issue's scope. */
async function tryClaimOnce(deps: Pick<AppDeps, "pool">, runner: RunnerIdentity, input: ClaimInput): Promise<ClaimedRow | undefined> {
  const result = await deps.pool.query<ClaimedRow>(CLAIM_QUERY, [
    runner.id,
    input.tags,
    input.slots,
    30, // spec: "Lease 30 detik" for ordinary StepRuns (60s is `kind: pull-request` only, out of scope here).
    null,
  ]);
  return result.rows[0];
}

async function hydrateClaimedRow(
  deps: Pick<AppDeps, "db" | "gitHost" | "keyring" | "objectStore">,
  row: ClaimedRow,
): Promise<ClaimedStepRun> {
  const [run] = await deps.db.select().from(runs).where(eq(runs.id, row.run_id));
  const [repository] = await deps.db.select().from(repositories).where(eq(repositories.id, row.repository_id));
  if (!run || !repository) {
    // Both are foreign keys `step_runs` requires NOT NULL — their absence
    // would mean the database itself is inconsistent, not a caller error.
    throw new Error(`claimed step run ${row.id} references a missing run or repository`);
  }
  const [project] = await deps.db.select().from(projects).where(eq(projects.id, run.projectId));
  if (!project) {
    throw new Error(`run ${run.id} references a missing project`);
  }
  const [installation] = await deps.db
    .select()
    .from(githubAppInstallations)
    .where(eq(githubAppInstallations.id, repository.githubAppInstallationId));
  if (!installation) {
    throw new Error(`repository ${repository.id} references a missing github app installation`);
  }

  // The one place this StepRun's final prompt is pinned down (AC5): the same
  // shared `renderFinalPrompt` the Runner uses to build the prompt it sends,
  // persisted on the row the moment the turn is claimed so the UI can show
  // "prompt final yang dikirim" — not the verbatim file content. Null for
  // run: Steps, which have no prompt. A fan-out branch resolves its *effective*
  // Step (parent Step merged with the Branch's overrides, `resolveEffectiveStep`)
  // so a branch with its own agent/prompt runs and is displayed as itself.
  const step = parseSnapshotStep(run.definition, row.step_key, row.branch_key);
  const finalPrompt = step ? finalPromptForStep(run.definitionFiles, step) : null;
  // Issue 13, AC5: the human's answer rides the final prompt of the resumed
  // turn. `resume_prompt` is rendered onto the new turn's row by the answer
  // handler, so the agent that resumes sees the answer in front of it.
  const effectiveFinalPrompt =
    finalPrompt !== null && row.resume_prompt !== null ? `${finalPrompt}\n\n${row.resume_prompt}` : finalPrompt;
  if (effectiveFinalPrompt !== null) {
    await deps.db
      .update(stepRuns)
      .set({ finalPrompt: effectiveFinalPrompt })
      .where(eq(stepRuns.id, row.id));
  }

  let askGroupId: Id<"group"> | null = null;
  if (step?.ask) {
    const [group] = await deps.db
      .select({ id: groups.id })
      .from(groups)
      .where(and(eq(groups.projectId, run.projectId), eq(groups.name, step.ask.group)));
    askGroupId = group?.id ?? null;
  }

  // The Join manifest (AC7) — assembled for a Step whose `after:` includes a
  // fan-out source; empty otherwise. `buildJoinManifest` needs the parsed
  // pipeline, so re-derive it once here.
  let joinManifest: JoinManifest = [];
  if (step) {
    const validation =
      typeof run.definition === "string" ? validatePipelineDefinition(run.definition) : null;
    if (validation?.valid) {
      joinManifest = (await buildJoinManifest(deps.db, run as RunRow, validation.pipeline, step)) ?? [];
    }
  }

  // The ref this turn forks from. A fresh turn forks from the Run's own ref;
  // a resumed turn (turn > 1, or one that carries a previous turn's pushed
  // branch) forks from where the conversation is — the branch the previous
  // turn pushed at its commit point (issue 13).
  const baseRef =
    row.output_ref_branch !== null && row.output_ref_sha !== null
      ? { branch: row.output_ref_branch, sha: row.output_ref_sha }
      : { branch: run.refBranch, sha: run.refSha };

  // The session the agent resumes from, when this is a resumed turn — a
  // freshly-minted 5-minute presigned GET (spec: "Presigned 5 menit"). The
  // Runner downloads the bytes straight from the object store; the control
  // plane never holds them (spec: "Byte tidak pernah lewat control plane").
  let session: ClaimedStepRun["session"] = null;
  if (row.session_blob_key !== null && row.session_id !== null) {
    const { url, expiresAt } = await deps.objectStore.mintGetUrl(row.session_blob_key);
    session = { id: row.session_id, blobKey: row.session_blob_key, getUrl: url, expiresAt };
  }

  return {
    id: row.id,
    runId: row.run_id,
    stepKey: row.step_key,
    branchKey: row.branch_key,
    turn: row.turn,
    attempt: row.attempt,
    repository: {
      id: repository.id,
      owner: repository.owner,
      name: repository.name,
      defaultBranch: repository.defaultBranch,
    },
    ref: baseRef,
    definition: run.definition,
    definitionFiles: run.definitionFiles,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at,
    gitTokens: await mintTurnTokens(deps, repository.owner, repository.name, installation.installationId),
    secrets: await resolveSecretsForPrincipal(deps, run.projectId, run.credentialPrincipalId),
    egressAllowlist: project.egressAllowlist,
    askGroupId,
    session,
    joinManifest,
  };
}

/** Parses the claimed run's definition snapshot and resolves the *effective* Step named by `stepKey` — Branch overrides applied when `branchKey` is set. Returns undefined when the snapshot is unusable. */
function parseSnapshotStep(
  definition: unknown,
  stepKey: string,
  branchKey: string | null,
): import("@factory/shared").Pipeline["steps"][string] | undefined {
  if (typeof definition !== "string") return undefined;
  const validation = validatePipelineDefinition(definition);
  if (!validation.valid) return undefined;
  return resolveEffectiveStep(validation.pipeline, stepKey, branchKey);
}

/** The final prompt for a Step — its own prompt text (promptFile content or inline prompt) plus the format-instruction block. Null when the Step has no prompt. */
function finalPromptForStep(
  definitionFiles: unknown,
  step: ReturnType<typeof parseSnapshotStep>,
): string | null {
  if (!step) return null;
  const basePrompt = step.promptFile
    ? (definitionFiles as Record<string, string> | undefined)?.[step.promptFile]
    : step.prompt;
  if (basePrompt === undefined) return null;
  return renderFinalPrompt(basePrompt, {
    ...(step.outputs !== undefined ? { outputs: step.outputs } : {}),
    ...(step.ask !== undefined ? { ask: step.ask } : {}),
  });
}

/**
 * The two mints per turn (spec: "token di-mint dua kali per giliran"). Both
 * are scoped to exactly this Repository with `contents: write` and nothing
 * else — see `domain/git-host.ts`'s `mintInstallationToken`. Minting is the
 * one outbound network call on the claim path, so it happens after the row
 * is safely leased; a failure un-leases the row (below) so the StepRun is
 * claimable again rather than stuck leased to a Runner that never got a
 * token.
 */
async function mintTurnTokens(
  deps: Pick<AppDeps, "gitHost">,
  owner: string,
  name: string,
  installationId: number,
): Promise<{ fetch: InstallationToken; push: InstallationToken }> {
  const repo: RepoRef = { owner, name };
  const [fetchToken, pushToken] = await Promise.all([
    deps.gitHost.mintInstallationToken(repo, installationId),
    deps.gitHost.mintInstallationToken(repo, installationId),
  ]);
  return { fetch: fetchToken, push: pushToken };
}

/** Rolls a just-claimed row back to `ready` — the StepRun is claimable again, no lease left behind. */
async function unleaseStepRun(deps: Pick<AppDeps, "db">, stepRunId: Id<"steprun">): Promise<void> {
  await deps.db
    .update(stepRuns)
    .set({ outcome: "ready", leasedBy: null, leaseToken: null, leaseExpiresAt: null })
    .where(eq(stepRuns.id, stepRunId));
}

/**
 * Long-polls `claim_step_run.sql` for up to a server-randomized 20-30s
 * (production; tests inject a smaller range via `deps.claimHoldRangeMs").
 * Returns `null` — never throws — when the hold elapses with nothing to
 * claim; that is a completely ordinary outcome for a Runner whose tags don't
 * currently match anything, not an error.
 *
 * Throws `ProtocolVersionError` (426) before doing anything else — no
 * connection-limiter slot is consumed and no polling happens for a Runner
 * outside the supported protocol range (spec: "`/claim` menjawab 426", and
 * distinctly from `/heartbeat`, which never does this).
 */
export async function claimStepRun(
  deps: Pick<AppDeps, "pool" | "db" | "random" | "claimHoldRangeMs" | "claimLimiter" | "gitHost" | "keyring" | "objectStore">,
  runner: RunnerIdentity,
  input: ClaimInput,
): Promise<ClaimedStepRun | null> {
  if (!isProtocolVersionSupported(input.protocolVersion)) {
    throw new ProtocolVersionError();
  }

  if (!deps.claimLimiter.tryAcquire()) {
    // Caller (route) maps this to 503 + Retry-After; `null` here would be
    // indistinguishable from "nothing to claim", which is a different,
    // non-error outcome the Runner reacts to differently.
    throw new ClaimCapacityError();
  }

  try {
    const { min, max } = deps.claimHoldRangeMs;
    const spreadMs = max - min;
    const randomByte = deps.random.bytes(1)[0] ?? 0;
    const holdMs = min + Math.floor((randomByte / 255) * spreadMs);
    const deadline = Date.now() + holdMs;

    for (;;) {
      const row = await tryClaimOnce(deps, runner, input);
      if (row) {
        try {
          return await hydrateClaimedRow(deps, row);
        } catch (error) {
          // Minting failed (GitHub transient) — the row is already leased, so
          // put it back on the queue rather than leaving it stuck running,
          // and keep polling: the next iteration (or a later claim) mints
          // fresh. Not thrown, because a transient GitHub outage must not
          // surface as a 5xx that looks like a control-plane fault.
          await unleaseStepRun(deps, row.id);
        }
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return null;
      }
      await sleep(Math.min(POLL_INTERVAL_MS, remaining));
    }
  } finally {
    deps.claimLimiter.release();
  }
}

/** Thrown only when the 2000-hanging-connection cap (spec) is already at capacity. Routes map this to `503` + `Retry-After` — a capacity signal, not a lease or protocol one, so it gets its own type rather than overloading `LeaseConflictError` or `ProtocolVersionError`. */
export class ClaimCapacityError extends Error {
  constructor() {
    super("too many hanging /claim connections");
    this.name = "ClaimCapacityError";
  }
}
