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
import { eq } from "drizzle-orm";
import { isProtocolVersionSupported, type Id } from "@factory/shared";
import { githubAppInstallations, repositories, runs, stepRuns } from "../db/schema.js";
import type { AppDeps } from "../deps.js";
import { loadSqlStatement } from "../db/sql/load.js";
import { ProtocolVersionError } from "./errors.js";
import type { InstallationToken, RepoRef } from "./git-host.js";
import type { RunnerIdentity } from "./runners.js";

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

async function hydrateClaimedRow(deps: Pick<AppDeps, "db" | "gitHost">, row: ClaimedRow): Promise<ClaimedStepRun> {
  const [run] = await deps.db.select().from(runs).where(eq(runs.id, row.run_id));
  const [repository] = await deps.db.select().from(repositories).where(eq(repositories.id, row.repository_id));
  if (!run || !repository) {
    // Both are foreign keys `step_runs` requires NOT NULL — their absence
    // would mean the database itself is inconsistent, not a caller error.
    throw new Error(`claimed step run ${row.id} references a missing run or repository`);
  }
  const [installation] = await deps.db
    .select()
    .from(githubAppInstallations)
    .where(eq(githubAppInstallations.id, repository.githubAppInstallationId));
  if (!installation) {
    throw new Error(`repository ${repository.id} references a missing github app installation`);
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
    ref: { branch: run.refBranch, sha: run.refSha },
    definition: run.definition,
    definitionFiles: run.definitionFiles,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at,
    gitTokens: await mintTurnTokens(deps, repository.owner, repository.name, installation.installationId),
  };
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
  deps: Pick<AppDeps, "pool" | "db" | "random" | "claimHoldRangeMs" | "claimLimiter" | "gitHost">,
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
