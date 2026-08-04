/**
 * The four Runner-surface endpoints that write to a specific, already-leased
 * StepRun mid- or end-of-turn: `/uploads`, `/log-chunks`, `/question`, and
 * `/result`. All four share one gate (`requireLeaseHolder` below) because
 * they share one invariant: none of them may succeed once the row has moved
 * on without the Runner — cancelled by an operator, or reassigned by the
 * lease sweep to someone else (spec: "Cancel otoritatif di control plane";
 * "/result dijaga lease_token itu sendiri").
 *
 * `/uploads` and `/log-chunks` are this issue's byte-free surface: they mint
 * presigned PUTs (uploads) and record metadata (log chunks) and never touch
 * a blob themselves — byte traffic is peer-to-peer with Garage (spec: "Byte
 * tidak pernah lewat control plane"). `mintUploadGrants` covers three kinds:
 * `artifact`, `session`, and this issue's `log` (the Runner mints one PUT per
 * chunk it is about to upload). `/log-chunks` genuinely persists to the real
 * `log_chunks` table, and its dedup-by-primary-key behavior is real.
 */
import { and, eq } from "drizzle-orm";
import type { Id } from "@factory/shared";
import { logChunks, questions, stepRuns } from "../db/schema.js";
import type { AppDeps } from "../deps.js";
import { DomainValidationError, LeaseConflictError } from "./errors.js";
import type { RunnerIdentity } from "./runners.js";
import { scheduleDependentsOf } from "./graph-advance.js";

type StepRunRow = typeof stepRuns.$inferSelect;

/**
 * Fetches the StepRun and enforces the one rule every turn-ending write
 * shares: `cancelled` always wins (even over a matching token — the row
 * moved on without the Runner, spec: "Cancel otoritatif"), and the
 * presented `lease_token` must equal the row's current one. Never 404 for a
 * StepRun id the Runner references — the Runner protocol's error set has no
 * 404 (spec, and see `errors.ts`'s `LeaseConflictError` doc).
 */
async function requireLeaseHolder(
  deps: Pick<AppDeps, "db">,
  stepRunId: Id<"steprun">,
  leaseToken: string,
): Promise<StepRunRow> {
  const [row] = await deps.db.select().from(stepRuns).where(eq(stepRuns.id, stepRunId));
  if (!row) {
    throw new LeaseConflictError("no such step run, or lease is no longer valid");
  }
  if (row.outcome === "cancelled") {
    throw new LeaseConflictError("step run was cancelled");
  }
  if (row.leaseToken !== leaseToken) {
    throw new LeaseConflictError("lease_token does not match the step run's current lease");
  }
  return row;
}

// --- /step-runs/:id/uploads ------------------------------------------------

export interface UploadRequest {
  key: string;
  kind: "artifact" | "session" | "log";
}

export interface UploadGrant {
  key: string;
  uploadUrl: string;
  expiresAt: Date;
}

/**
 * The blob key a grant's PUT writes to. One bucket, three prefixes (spec:
 * "Artifact dan blob": "Satu bucket, tiga prefix: artifact, log, session").
 * The Runner passes the tail (`key`) and this maps kind → prefix + StepRun,
 * so the Runner never has to know or trust the bucket layout. For `log`,
 * the Runner passes `key = "{attempt}/{seq}"`, making the object
 * `log/{stepRunId}/{attempt}/{seq}` — unique per primary key row, which is
 * what makes "baris log_chunks ada ⇒ blob pasti ada" hold row for row.
 */
export function blobKeyFor(stepRunId: Id<"steprun">, request: UploadRequest): string {
  return `${request.kind}/${stepRunId}/${request.key}`;
}

/**
 * Mints presigned PUT grants — the control plane records *nothing* about the
 * bytes, it just mints URLs (spec: "Control plane tidak memegang byte").
 * `expiresAt` is the stated 5-minute presigned lifetime (spec: "Presigned 5
 * menit dinyatakan, tidak diperpendek").
 */
export async function mintUploadGrants(
  deps: Pick<AppDeps, "db" | "objectStore">,
  runner: RunnerIdentity,
  stepRunId: Id<"steprun">,
  leaseToken: string,
  requests: UploadRequest[],
): Promise<UploadGrant[]> {
  const row = await requireLeaseHolder(deps, stepRunId, leaseToken);
  if (row.outcome !== "running" || row.leasedBy !== runner.id) {
    throw new LeaseConflictError("step run is not currently leased to this runner");
  }
  const grants: UploadGrant[] = [];
  for (const request of requests) {
    const { url, expiresAt } = await deps.objectStore.mintPutUrl(blobKeyFor(stepRunId, request));
    grants.push({ key: request.key, uploadUrl: url, expiresAt });
  }
  return grants;
}

// --- /step-runs/:id/log-chunks ---------------------------------------------

export interface LogChunkInput {
  attempt: number;
  seq: number;
  blobKey: string;
  byteOffset: number;
  size: number;
}

/** Dedup at the primary key `(step_run_id, attempt, seq)`, not in code (spec: "Log") — a resend of the same chunk is `ON CONFLICT DO NOTHING`, never a 409. */
export async function recordLogChunks(
  deps: Pick<AppDeps, "db">,
  runner: RunnerIdentity,
  stepRunId: Id<"steprun">,
  leaseToken: string,
  chunks: LogChunkInput[],
): Promise<void> {
  const row = await requireLeaseHolder(deps, stepRunId, leaseToken);
  if (row.outcome !== "running" || row.leasedBy !== runner.id) {
    throw new LeaseConflictError("step run is not currently leased to this runner");
  }
  if (chunks.length === 0) {
    return;
  }
  await deps.db
    .insert(logChunks)
    .values(
      chunks.map((chunk) => ({
        stepRunId,
        attempt: chunk.attempt,
        seq: chunk.seq,
        blobKey: chunk.blobKey,
        byteOffset: chunk.byteOffset,
        size: chunk.size,
      })),
    )
    .onConflictDoNothing();
}

// --- /step-runs/:id/question -------------------------------------------

export interface QuestionInput {
  id: Id<"question">; // client-generated — the idempotency key (spec: "Question dijaga id yang dibangkitkan klien").
  groupId: Id<"group">;
  kind: "text" | "choice" | "approval" | "edit-artifact";
  body: string;
  options?: { id: string; label: string; description?: string | undefined }[] | undefined;
  multi?: boolean | undefined;
  allowOther?: boolean | undefined;
  artifactKey?: string | undefined;
  ref: { branch: string; sha: string };
  sessionBlobKey?: string | undefined;
}

/**
 * Ends a turn by publishing a Question and moving the StepRun to
 * `awaiting-human` **without a lease** (spec: "StepRun jadi baris database
 * tanpa lease — Sandbox ditutup, Runner bebas"). `lease_token` is
 * deliberately left on the row (not nulled) after the transition — the same
 * trick `/result` uses — so a retried identical POST (same id, same token)
 * can be recognized and replayed instead of rejected.
 */
export async function submitQuestion(
  deps: Pick<AppDeps, "db">,
  runner: RunnerIdentity,
  stepRunId: Id<"steprun">,
  leaseToken: string,
  input: QuestionInput,
): Promise<{ questionId: Id<"question"> }> {
  const row = await requireLeaseHolder(deps, stepRunId, leaseToken);

  if (row.outcome === "awaiting-human") {
    const [existing] = await deps.db
      .select()
      .from(questions)
      .where(and(eq(questions.stepRunId, stepRunId), eq(questions.id, input.id)));
    if (existing) {
      return { questionId: existing.id }; // idempotent replay
    }
    throw new LeaseConflictError("step run already moved to awaiting-human under a different question");
  }

  if (row.outcome !== "running" || row.leasedBy !== runner.id) {
    throw new LeaseConflictError("step run is not currently leased to this runner");
  }

  await deps.db
    .insert(questions)
    .values({
      id: input.id,
      stepRunId,
      groupId: input.groupId,
      kind: input.kind,
      body: input.body,
      options: input.options,
      multi: input.multi,
      allowOther: input.allowOther,
      artifactKey: input.artifactKey,
    })
    .onConflictDoNothing();

  await deps.db
    .update(stepRuns)
    .set({
      outcome: "awaiting-human",
      leasedBy: null,
      leaseExpiresAt: null,
      outputRefBranch: input.ref.branch,
      outputRefSha: input.ref.sha,
      sessionBlobKey: input.sessionBlobKey ?? row.sessionBlobKey,
    })
    .where(eq(stepRuns.id, stepRunId));

  return { questionId: input.id };
}

// --- /step-runs/:id/result --------------------------------------------

export interface ResultInput {
  outcome: "succeeded" | "failed";
  ref?: { branch: string; sha: string } | undefined;
  outputData?: unknown;
  reason?: string | undefined;
}

export interface ResultRecord {
  outcome: "succeeded" | "failed";
  ref: { branch: string; sha: string } | null;
  outputData: unknown;
}

function toResultRecord(row: StepRunRow): ResultRecord {
  return {
    outcome: row.outcome as "succeeded" | "failed",
    ref: row.outputRefBranch && row.outputRefSha ? { branch: row.outputRefBranch, sha: row.outputRefSha } : null,
    outputData: row.outputData,
  };
}

/**
 * Ends a turn successfully or with failure. Idempotency keys on
 * `lease_token` itself, not a new field (spec: "nol kunci baru ... `/result`
 * dijaga lease_token itu sendiri"): the same token replays the previously
 * recorded outcome at `200`; the row having moved on (a different token now
 * current, or `cancelled`) is `409`, and the Runner is fenced.
 *
 * On a first-time `succeeded` commit of a non-fan-out StepRun, also calls
 * `graph-advance.ts`'s `scheduleDependentsOf` — the "advance the Graph"
 * mechanism issue #4 left unbuilt because nothing could move a StepRun to a
 * terminal state before this function existed (see that file's header for
 * the full reasoning and the shape chosen). Never re-runs on an idempotent
 * replay — only the branch that actually just flipped the row to
 * `succeeded` calls it.
 *
 * The invariant of the turn's commit point (spec: "push branch → unggah blob
 * → POST result ... StepRun `succeeded` ada ⇒ ref ada") is enforced here,
 * authoritatively: a `succeeded` result without a `ref` is a
 * `DomainValidationError` (400), not a stored row. A `failed` result may
 * carry an optional `ref` — the branch may have been pushed before the turn
 * went sideways (spec: "ref opsional bila branch sempat terdorong").
 */
export async function submitResult(
  deps: Pick<AppDeps, "db" | "clock">,
  runner: RunnerIdentity,
  stepRunId: Id<"steprun">,
  leaseToken: string,
  input: ResultInput,
): Promise<ResultRecord> {
  const row = await requireLeaseHolder(deps, stepRunId, leaseToken);

  if (row.outcome === "succeeded" || row.outcome === "failed") {
    return toResultRecord(row); // idempotent replay — same lease_token, already committed.
  }

  if (row.outcome !== "running" || row.leasedBy !== runner.id) {
    throw new LeaseConflictError("step run is not currently leased to this runner");
  }

  if (input.outcome === "succeeded" && !input.ref) {
    throw new DomainValidationError(
      "result_ref_required",
      "a succeeded step run must report the ref it pushed (push branch → upload blob → POST /result)",
    );
  }

  const [updated] = await deps.db
    .update(stepRuns)
    .set({
      outcome: input.outcome,
      reason: input.reason ?? null,
      outputRefBranch: input.ref?.branch ?? null,
      outputRefSha: input.ref?.sha ?? null,
      outputData: input.outputData ?? null,
    })
    .where(eq(stepRuns.id, stepRunId))
    .returning();

  if (input.outcome === "succeeded" && row.branchKey === null) {
    await scheduleDependentsOf(deps, row.runId, row.stepKey);
  }

  return toResultRecord(updated!);
}
