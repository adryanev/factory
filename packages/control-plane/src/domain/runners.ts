/**
 * Every read or write of `runners` / `runner_join_tokens` goes through here
 * — the Runner-protocol analogue of `projects.ts`. Two different callers use
 * this file for two different reasons, and the split matters:
 *
 *  - The Runner itself (join, capabilities report, self-drain, heartbeat)
 *    authenticates with a bearer secret, never a `Principal` — there is no
 *    session cookie on an outbound-only machine with no browser. Its
 *    identity is `RunnerIdentity`, resolved by `authenticateRunner` from the
 *    `Authorization` header, and threaded through explicitly exactly the way
 *    `Principal` is (see module doc on `domain/index.ts`) — `RouteDeps` still
 *    has no `db`, so `routes/runner-protocol.ts` cannot reach `runners`
 *    except through the functions below.
 *  - An operator (mint a join token, set slots/tags policy, drain, revoke)
 *    authenticates with a normal session and passes a `Principal`, gated on
 *    org `owner` — the Runner pool is org-wide, not Project-scoped (see
 *    `db/schema/runners.ts`), so Project `admin` has no meaning here.
 *
 * `heartbeat` is the busiest function in this file — it renews leases,
 * separates `cancel` from `unknown_leases` (spec: "Kontrak API control-plane
 * <-> Runner" — the two must never merge into one list), and always
 * succeeds regardless of the caller's protocol version (spec: "/heartbeat
 * selalu diterima walau protokol di luar rentang").
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { encodeBase32, generateId, SUPPORTED_PROTOCOL_RANGE, type Id } from "@factory/shared";
import { runnerJoinTokens, runners, stepRuns } from "../db/schema.js";
import type { AppDeps } from "../deps.js";
import type { Principal } from "./principal.js";
import { getOrgRole } from "./projects.js";
import { ForbiddenError, NotFoundError, UnauthorizedError } from "./errors.js";
import { generateRunnerSecret, hashRunnerSecret, runnerSecretDisplayPrefix } from "./runner-secret.js";
import { hashToken } from "./token-hash.js";

export type DesiredState = "active" | "draining" | "revoked";
export type Runner = typeof runners.$inferSelect;

/** What every Runner-surface route resolves from the `Authorization` header instead of a `Principal` — see module doc. */
export interface RunnerIdentity {
  id: Id<"runner">;
}

async function requireOrgOwner(deps: Pick<AppDeps, "db">, principal: Principal): Promise<void> {
  const role = await getOrgRole(deps, principal);
  if (role !== "owner") {
    throw new ForbiddenError("forbidden_not_org_owner", "only an org owner may manage the Runner pool");
  }
}

const JOIN_TOKEN_BYTE_LENGTH = 20;

/** Operator action: mints a single-use join token. Raw value returned exactly once — only its hash is ever stored (spec: "runner_join_tokens" doc in `db/schema/runners.ts`). */
export async function mintJoinToken(
  deps: Pick<AppDeps, "db" | "random">,
  principal: Principal,
): Promise<{ token: string }> {
  await requireOrgOwner(deps, principal);
  const token = `jtk_${encodeBase32(deps.random.bytes(JOIN_TOKEN_BYTE_LENGTH))}`;
  await deps.db.insert(runnerJoinTokens).values({
    id: generateId("jointoken"),
    tokenHash: hashToken(token),
    createdByPrincipalId: principal.id,
  });
  return { token };
}

const DEFAULT_SLOTS = 1; // a freshly-joined machine can do one unit of work immediately; an operator raises this via `setRunnerPolicy` (spec: "slots dan label ditulis operator" is a ceiling operators can move, not a gate that blocks first use).

/**
 * Exchanges a single-use join token for a runner id + secret (spec: "Join
 * token sekali pakai ditukar jadi runner-id + secret di disk"). The
 * compare-and-set `usedAt IS NULL` in the WHERE clause is the single-use
 * enforcement — a second exchange of the same token affects zero rows and
 * is reported as `UnauthorizedError`, not a 500, because a race on the same
 * token is an expected, not exceptional, caller error.
 */
export async function joinRunner(
  deps: Pick<AppDeps, "db" | "random" | "clock">,
  token: string,
): Promise<{ runnerId: Id<"runner">; secret: string }> {
  const tokenHash = hashToken(token);
  const runnerId = generateId("runner");
  const secret = generateRunnerSecret((length) => deps.random.bytes(length));

  // One transaction: `runner_join_tokens.runner_id` is a foreign key into
  // `runners`, so the runner row must exist before the token can be marked
  // consumed — but if the compare-and-set below turns out to affect zero
  // rows (token already used, racing another `/join`), the transaction
  // rolls the runner insert back too, so a failed join never leaves an
  // orphaned `runners` row behind.
  await deps.db.transaction(async (tx) => {
    await tx.insert(runners).values({
      id: runnerId,
      secretHash: hashRunnerSecret(secret),
      secretPrefix: runnerSecretDisplayPrefix(secret),
      desiredState: "active",
      tags: [],
      slots: DEFAULT_SLOTS,
    });

    const claimed = await tx
      .update(runnerJoinTokens)
      .set({ usedAt: deps.clock.now(), runnerId })
      .where(and(eq(runnerJoinTokens.tokenHash, tokenHash), isNull(runnerJoinTokens.usedAt)))
      .returning();

    if (claimed.length === 0) {
      // Throwing inside the transaction rolls back the runner insert above
      // too — a rejected join must never leave an orphaned `runners` row.
      throw new UnauthorizedError("join token is invalid, already used, or unknown");
    }
  });

  return { runnerId, secret };
}

const BEARER_PREFIX = "Bearer ";

/** Parses `Authorization: Bearer <secret>`. Throws `UnauthorizedError` for anything else — a missing or malformed header is exactly as fatal as a wrong secret (spec error table: `401` stops the Runner either way). */
export function parseBearerSecret(authorizationHeader: string | undefined): string {
  if (!authorizationHeader?.startsWith(BEARER_PREFIX)) {
    throw new UnauthorizedError("missing or malformed Authorization header");
  }
  const secret = authorizationHeader.slice(BEARER_PREFIX.length).trim();
  if (!secret) {
    throw new UnauthorizedError("missing or malformed Authorization header");
  }
  return secret;
}

/**
 * Resolves the bearer secret to a `RunnerIdentity`. A revoked Runner's
 * secret is refused here, at the front door of every Runner-surface route —
 * this **is** the fencing mechanism (spec: "Revoke adalah fencing, bukan
 * pembunuhan": the control plane cannot reach into a remote machine over an
 * outbound-only connection and kill anything, so refusing to trust its
 * secret any further is the only lever it has, and it is instant).
 */
export async function authenticateRunner(deps: Pick<AppDeps, "db">, bearerSecret: string): Promise<RunnerIdentity> {
  const [row] = await deps.db.select().from(runners).where(eq(runners.secretHash, hashRunnerSecret(bearerSecret)));
  if (!row || row.desiredState === "revoked") {
    throw new UnauthorizedError("runner secret is invalid or has been revoked");
  }
  return { id: row.id };
}

/** Full capabilities report, sent when the Runner's locally-computed `caps_hash` no longer matches what the control plane last recorded (spec: "hash-nya ikut tiap heartbeat; control plane meminta laporan penuh saat hash berubah"). */
export async function reportCapabilities(
  deps: Pick<AppDeps, "db">,
  runner: RunnerIdentity,
  capsHash: string,
  capabilities: unknown,
  releaseVersion: string | undefined,
): Promise<void> {
  await deps.db
    .update(runners)
    .set({ capsHash, capabilities, releaseVersion: releaseVersion ?? undefined })
    .where(eq(runners.id, runner.id));
}

/** Runner-initiated drain (the CLI-local write path; see `drainRunner` below for the operator/UI path into the same column). Idempotent — draining an already-draining Runner is a no-op, not an error. */
export async function selfDrain(deps: Pick<AppDeps, "db">, runner: RunnerIdentity): Promise<void> {
  await deps.db
    .update(runners)
    .set({ desiredState: "draining" })
    .where(and(eq(runners.id, runner.id), eq(runners.desiredState, "active")));
}

export interface HeartbeatLease {
  stepRunId: Id<"steprun">;
  leaseToken: string;
}

export interface HeartbeatReply {
  desiredState: DesiredState;
  /** StepRuns the control plane has authoritatively marked `cancelled` — the Runner should stop burning CPU on them (spec: "unknown_leases terpisah dari cancel"). */
  cancel: Id<"steprun">[];
  /** Leases the Runner reports holding that the control plane no longer recognizes as theirs — lost to a lease sweep, reassigned, or never existed. Never the same list as `cancel` (spec, verbatim: two different causes in one list would erase an operator's ability to tell them apart). */
  unknownLeases: Id<"steprun">[];
  capsStale: boolean;
  latestRelease: string;
  protocol: { min: number; max: number };
}

/** Hardcoded pending a real release registry — not one of this issue's acceptance criteria, and every caller (heartbeat reply, and eventually a "Runner out of date" UI badge) only ever reads it, never sets it. */
const LATEST_KNOWN_RELEASE = "0.1.0";

const LEASE_SECONDS = 30; // spec: "Lease 30 detik diperbarui heartbeat 10 detik" — see also claim_step_run.sql's `$4`.

/**
 * The one endpoint the Runner protocol promises will *always* answer 200
 * (spec: "/heartbeat selalu diterima walau protokol di luar rentang") — this
 * function never throws for a caller-side reason; every failure mode is
 * expressed in the reply body instead.
 *
 * For each reported lease: `cancelled` wins over everything (the row is
 * authoritative the instant an operator cancels it, spec: "Cancel otoritatif
 * di control plane"); otherwise a `lease_token` that still matches the row's
 * current one and is still `running` gets renewed; anything else — wrong
 * token, reassigned by a sweep, a StepRun id the control plane has never
 * heard of — is `unknown_leases`, never `cancel`.
 */
export async function heartbeat(
  deps: Pick<AppDeps, "db">,
  runner: RunnerIdentity,
  input: { leases: HeartbeatLease[]; capsHash: string | null; protocolVersion: number | null },
): Promise<HeartbeatReply> {
  const [row] = await deps.db.select().from(runners).where(eq(runners.id, runner.id));
  if (!row) {
    // Authenticated (the secret hashed to a real row a moment ago in
    // `authenticateRunner`) but gone by the time we get here is not a
    // caller error — treat as draining-into-nothing rather than throw.
    return {
      desiredState: "revoked",
      cancel: [],
      unknownLeases: input.leases.map((l) => l.stepRunId),
      capsStale: false,
      latestRelease: LATEST_KNOWN_RELEASE,
      protocol: SUPPORTED_PROTOCOL_RANGE,
    };
  }

  // `now()` — Postgres's, not `deps.clock`'s — deliberately: lease math must
  // share exactly one clock with `claim_step_run.sql`, which stamps
  // `lease_expires_at` with Postgres's own `now()` and is not this issue's
  // to rewrite (see that file's header). Comparing a lease written by one
  // clock against a renewal computed from a different, independently
  // injected one is exactly the kind of drift that would make this
  // untestable with a fixed test clock and unsound with a real one.
  await deps.db.update(runners).set({ lastHeartbeatAt: sql`now()` }).where(eq(runners.id, runner.id));

  const cancel: Id<"steprun">[] = [];
  const unknownLeases: Id<"steprun">[] = [];

  for (const lease of input.leases) {
    const [stepRun] = await deps.db.select().from(stepRuns).where(eq(stepRuns.id, lease.stepRunId));
    if (!stepRun) {
      unknownLeases.push(lease.stepRunId);
      continue;
    }
    if (stepRun.outcome === "cancelled") {
      cancel.push(lease.stepRunId);
      continue;
    }
    if (stepRun.outcome !== "running" || stepRun.leasedBy !== runner.id || stepRun.leaseToken !== lease.leaseToken) {
      unknownLeases.push(lease.stepRunId);
      continue;
    }
    await deps.db
      .update(stepRuns)
      .set({ leaseExpiresAt: sql`now() + (${LEASE_SECONDS} * interval '1 second')` })
      .where(eq(stepRuns.id, lease.stepRunId));
  }

  const capsStale = input.capsHash !== null && input.capsHash !== row.capsHash;

  return {
    desiredState: row.desiredState,
    cancel,
    unknownLeases,
    capsStale,
    latestRelease: LATEST_KNOWN_RELEASE,
    protocol: SUPPORTED_PROTOCOL_RANGE,
  };
}

// --- Operator surface (Principal, org `owner`) ---------------------------

async function getRunnerOrThrow(deps: Pick<AppDeps, "db">, runnerId: Id<"runner">): Promise<Runner> {
  const [row] = await deps.db.select().from(runners).where(eq(runners.id, runnerId));
  if (!row) {
    throw new NotFoundError("runner", runnerId);
  }
  return row;
}

/** Operator policy write: `slots` and `tags` (spec: "kebijakan ditulis operator"). Distinct from the Runner-reported *facts* in `reportCapabilities` — a Runner can tell the control plane what it has, never how much of it to lend out. */
export async function setRunnerPolicy(
  deps: Pick<AppDeps, "db">,
  principal: Principal,
  runnerId: Id<"runner">,
  policy: { slots: number; tags: string[] },
): Promise<void> {
  await requireOrgOwner(deps, principal);
  await getRunnerOrThrow(deps, runnerId);
  await deps.db.update(runners).set({ slots: policy.slots, tags: policy.tags }).where(eq(runners.id, runnerId));
}

/** Operator/UI path into `desired_state = 'draining'` — the CLI-local path is `selfDrain` above; both write the same column (spec: "Drain dan revoke lewat satu kolom desired_state, ditulis CLI lokal maupun tombol UI"). */
export async function drainRunner(deps: Pick<AppDeps, "db">, principal: Principal, runnerId: Id<"runner">): Promise<void> {
  await requireOrgOwner(deps, principal);
  await getRunnerOrThrow(deps, runnerId);
  await deps.db.update(runners).set({ desiredState: "draining" }).where(eq(runners.id, runnerId));
}

/**
 * Fencing, not killing (spec, verbatim). Takes effect the instant this
 * commits: the next call `authenticateRunner` makes for this Runner's
 * secret is refused outright, regardless of whether the physical process is
 * still alive — the control plane has no way to reach it over an
 * outbound-only connection, so refusing further trust is the entire
 * mechanism.
 */
export async function revokeRunner(deps: Pick<AppDeps, "db">, principal: Principal, runnerId: Id<"runner">): Promise<void> {
  await requireOrgOwner(deps, principal);
  await getRunnerOrThrow(deps, runnerId);
  await deps.db.update(runners).set({ desiredState: "revoked" }).where(eq(runners.id, runnerId));
}
