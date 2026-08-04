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
import { repositories, runs } from "../db/schema.js";
import type { AppDeps } from "../deps.js";
import { loadSqlStatement } from "../db/sql/load.js";
import { ProtocolVersionError } from "./errors.js";
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

async function hydrateClaimedRow(deps: Pick<AppDeps, "db">, row: ClaimedRow): Promise<ClaimedStepRun> {
  const [run] = await deps.db.select().from(runs).where(eq(runs.id, row.run_id));
  const [repository] = await deps.db.select().from(repositories).where(eq(repositories.id, row.repository_id));
  if (!run || !repository) {
    // Both are foreign keys `step_runs` requires NOT NULL — their absence
    // would mean the database itself is inconsistent, not a caller error.
    throw new Error(`claimed step run ${row.id} references a missing run or repository`);
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
  };
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
  deps: Pick<AppDeps, "pool" | "db" | "random" | "claimHoldRangeMs" | "claimLimiter">,
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
        return hydrateClaimedRow(deps, row);
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
