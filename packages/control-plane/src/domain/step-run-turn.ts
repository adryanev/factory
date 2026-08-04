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
import { and, eq, inArray } from "drizzle-orm";
import {
  generateId,
  isArtifactKind,
  normalizeArtifactKey,
  type ArtifactKind,
  type Id,
} from "@factory/shared";
import { compileStepOutputContract, validatePipelineDefinition } from "@factory/shared";
import { artifacts, logChunks, questions, runs, stepRuns, stepRunUploadGrants } from "../db/schema.js";
import type { Database } from "../db/client.js";
import type { AppDeps } from "../deps.js";
import { DomainValidationError, LeaseConflictError } from "./errors.js";
import type { RunnerIdentity } from "./runners.js";
import { advanceGraph, finalizeRunIfDone, parsePipelineSnapshot, type RunRow } from "./graph-advance.js";

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

/** Kuota per artefak: 1 GiB (spec: "Kuota 1 GiB per artefak"). */
export const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;
/** Kuota per StepRun: 5 GiB (spec: "dan 5 GiB per StepRun"). */
export const MAX_STEPRUN_ARTIFACT_BYTES = 5 * MAX_ARTIFACT_BYTES;

export interface UploadRequest {
  key: string;
  kind: "artifact" | "session" | "log";
  /** Declared size in bytes — required for `artifact` so quota is rejected *at URL-mint time*, before a byte is uploaded (spec: "ditolak saat URL diminta, bukan setelah byte naik"). Ignored for `session`/`log`. */
  sizeBytes?: number;
}

export interface UploadGrant {
  /** The stored key — an artifact key is the *normalized slug* (spec: "key dinormalisasi slug"). */
  key: string;
  uploadUrl: string;
  expiresAt: Date;
  /** The exact object the PUT writes — returned so the Runner never has to guess the bucket layout. */
  blobKey: string;
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

/** The key a grant is stored under — artifact keys are slug-normalized before they become blob paths. */
function grantKeyFor(request: UploadRequest): string {
  return request.kind === "artifact" ? normalizeArtifactKey(request.key) : request.key;
}

/**
 * Mints presigned PUT grants — the control plane records *nothing* about the
 * bytes, it just mints URLs (spec: "Control plane tidak memegang byte").
 * `expiresAt` is the stated 5-minute presigned lifetime (spec: "Presigned 5
 * menit dinyatakan, tidak diperpendek").
 *
 * The grant *batch* — the `artifact`/`session` requests, the spec's "satu
 * batch berisi seluruh artefak plus session" — is stored in
 * `step_run_upload_grants`, and a repeated request **replaces** the previous
 * batch instead of adding (spec: "`/uploads` mengganti grant sebelumnya
 * alih-alih menambah, sehingga kuota diperiksa atas satu daftar utuh dan
 * tidak pernah hanyut"). The quota is therefore checked against exactly one
 * whole list at mint time — 1 GiB per artifact, 5 GiB per StepRun — and a
 * later `/result` only accepts artifacts that are still in the current
 * batch, so repeated requests cannot drift past it (AC2/AC3).
 *
 * `kind: "log"` requests are minted one per chunk by the Runner's log
 * flush and deliberately never touch the stored batch — otherwise every
 * chunk mint would wipe the turn's artifact grants.
 */
export async function mintUploadGrants(
  deps: Pick<AppDeps, "db" | "objectStore" | "clock">,
  runner: RunnerIdentity,
  stepRunId: Id<"steprun">,
  leaseToken: string,
  requests: UploadRequest[],
): Promise<UploadGrant[]> {
  const row = await requireLeaseHolder(deps, stepRunId, leaseToken);
  if (row.outcome !== "running" || row.leasedBy !== runner.id) {
    throw new LeaseConflictError("step run is not currently leased to this runner");
  }

  const artifacts_ = requests.filter((request) => request.kind === "artifact");
  const tracked = requests.filter((request) => request.kind !== "log");

  // Quota at URL-mint time (AC3). Duplicate keys within one batch are
  // rejected too — two artifacts sharing one (step_run, key) would collide
  // on the artifacts UNIQUE constraint the moment /result tries to record
  // both, so the batch is refused up front.
  const seen = new Set<string>();
  const batchTotal = artifacts_.reduce((sum, request) => {
    if (request.sizeBytes === undefined) {
      throw new DomainValidationError(
        "artifact_size_required",
        `artifact '${request.key}' must declare size_bytes so quota is checked before any byte is uploaded`,
      );
    }
    if (request.sizeBytes > MAX_ARTIFACT_BYTES) {
      throw new DomainValidationError(
        "artifact_too_large",
        `artifact '${request.key}' is ${request.sizeBytes} bytes, over the ${MAX_ARTIFACT_BYTES}-byte per-artifact quota`,
      );
    }
    const key = normalizeArtifactKey(request.key);
    if (seen.has(key)) {
      throw new DomainValidationError(
        "artifact_key_conflict",
        `artifact key '${key}' appears more than once in this upload batch`,
      );
    }
    seen.add(key);
    return sum + request.sizeBytes;
  }, 0);
  if (batchTotal > MAX_STEPRUN_ARTIFACT_BYTES) {
    throw new DomainValidationError(
      "artifact_quota_exceeded",
      `this upload batch declares ${batchTotal} bytes of artifacts, over the ${MAX_STEPRUN_ARTIFACT_BYTES}-byte per-StepRun quota`,
    );
  }

  const grants: UploadGrant[] = [];
  for (const request of requests) {
    const key = grantKeyFor(request);
    const blobKey = blobKeyFor(stepRunId, { ...request, key });
    const { url, expiresAt } = await deps.objectStore.mintPutUrl(blobKey);
    grants.push({ key, uploadUrl: url, expiresAt, blobKey });
  }

  // Replace, never add — and only for the artifact/session batch, so the
  // Runner's one-per-chunk log grants leave the batch untouched.
  if (tracked.length > 0) {
    const now = deps.clock.now();
    await deps.db.transaction(async (tx) => {
      await tx
        .delete(stepRunUploadGrants)
        .where(
          and(
            eq(stepRunUploadGrants.stepRunId, stepRunId),
            eq(stepRunUploadGrants.attempt, row.attempt),
            inArray(stepRunUploadGrants.kind, ["artifact", "session"]),
          ),
        );
      await tx.insert(stepRunUploadGrants).values(
        tracked.map((request) => ({
          stepRunId,
          attempt: row.attempt,
          key: grantKeyFor(request),
          kind: request.kind,
          sizeBytes: request.kind === "artifact" ? request.sizeBytes : 0,
          blobKey: blobKeyFor(stepRunId, { ...request, key: grantKeyFor(request) }),
          grantedAt: now,
        })),
      );
    });
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
  /** The agent session id the blob carries — preserved so a resumed turn can `resumeSession` it (issue 13, AC2). */
  sessionId?: string | undefined;
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
      sessionId: input.sessionId ?? row.sessionId,
    })
    .where(eq(stepRuns.id, stepRunId));

  // The turn's upload grants are consumed here — the session blob is now
  // referenced by `session_blob_key` and the artifact batch was never
  // recorded (a question turn records no artifacts), so the batch must not
  // outlive its turn.
  await deps.db
    .delete(stepRunUploadGrants)
    .where(
      and(eq(stepRunUploadGrants.stepRunId, stepRunId), eq(stepRunUploadGrants.attempt, row.attempt)),
    );

  return { questionId: input.id };
}

// --- /step-runs/:id/result --------------------------------------------

/** Metadata of one artifact that already uploaded to the object store, riding `POST /result` (spec: "Metadata Artifact menumpang request akhir itu"). */
export interface ArtifactMetadataInput {
  /** Reported by the Runner; stored under the normalized slug (spec: "key dinormalisasi slug"). */
  key: string;
  kind: ArtifactKind;
  contentType: string;
  sizeBytes: number;
}

export interface ResultInput {
  outcome: "succeeded" | "failed";
  ref?: { branch: string; sha: string } | undefined;
  outputData?: unknown;
  reason?: string | undefined;
  /** Only meaningful on `succeeded` — a failed turn records nothing, the whole turn "seolah tidak pernah terjadi" (spec). */
  artifacts?: ArtifactMetadataInput[] | undefined;
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
 * The authoritative gate on an agent Step's Output (issue 9, AC6/AC7): the
 * `output_data` a Runner reports at `/result` is checked against the *same*
 * discriminated union the Runner itself compiled from the same definition
 * snapshot (`compileStepOutputContract`, shared by both sides). Only the
 * `done` arm may arrive here — a `question` has its own endpoint and its own
 * commit point (`/question`); an Output that fails this gate turns the whole
 * turn into `failed` with `reason: output-invalid`, consuming the ordinary
 * attempt, and the branch that was already pushed becomes an orphan for GC.
 *
 * Returns `no-contract` when the Step has no output contract (`run:` Steps
 * report no `output_data` and are never gated), `invalid` when the Output
 * fails the union, and the parsed `done` arm when valid.
 */
function checkStepOutput(
  definition: unknown,
  stepKey: string,
  outputData: unknown,
): { kind: "no-contract" } | { kind: "invalid" } | { kind: "done"; outputs: unknown } {
  if (typeof definition !== "string") {
    return { kind: "no-contract" }; // no snapshot to validate against — a run: Step.
  }
  const validation = validatePipelineDefinition(definition);
  if (!validation.valid) {
    // The definition validated at trigger time; a re-validation failure here
    // is a control-plane inconsistency, not a Runner's fault to absorb.
    return { kind: "no-contract" };
  }
  const step = validation.pipeline.steps[stepKey];
  if (!step || (step.outputs === undefined && step.ask === undefined)) {
    return { kind: "no-contract" };
  }

  const contract = compileStepOutputContract({
    ...(step.outputs !== undefined ? { outputs: step.outputs } : {}),
    ...(step.ask !== undefined ? { ask: step.ask } : {}),
  });
  const parsed = contract.safeParse(outputData);
  if (!parsed.success || (parsed.data as { kind?: string }).kind !== "done") {
    return { kind: "invalid" };
  }
  return { kind: "done", outputs: (parsed.data as { outputs: unknown }).outputs };
}

/**
 * Records the artifacts of a `succeeded` turn inside the same transaction as
 * the row update, so a rejected artifact batch makes the whole turn "seolah
 * tidak pernah terjadi" (spec). The upload-before-record order is the
 * Runner's; what is enforced here is that metadata *rides* `/result` (AC4)
 * and that it stays honest:
 *
 *  - every recorded artifact must be in the current grant batch
 *    (`step_run_upload_grants` for this attempt) — artifacts from a batch
 *    that `/uploads` has since replaced are refused, which is the structural
 *    half of "kuota tidak bisa hanyut lewat permintaan berulang" (AC3);
 *  - the recorded size must not exceed the size declared at URL-mint time,
 *    and per-artifact/per-StepRun quotas are re-checked against the recorded
 *    numbers — the second half of the same guarantee, provable even if the
 *    Runner declared small sizes and reported large ones;
 *  - `blob_key` is taken from the grant row the control plane minted, never
 *    reported by the Runner — the control plane does not trust a Runner's
 *    guess about the bucket layout.
 *
 * Invariant: a row in `artifacts` exists ⇒ its blob exists in the object
 * store, because the Runner PUTs the bytes before POSTing `/result` and only
 * the successfully-uploaded subset is ever listed here (AC4/AC5). A blob
 * whose metadata never arrived is an orphan for the retention GC.
 */
async function recordArtifacts(
  tx: Database,
  now: Date,
  row: StepRunRow,
  artifacts_: ArtifactMetadataInput[],
): Promise<void> {
  if (artifacts_.length === 0) {
    return;
  }
  const grants = await tx.select().from(stepRunUploadGrants).where(
    and(
      eq(stepRunUploadGrants.stepRunId, row.id),
      eq(stepRunUploadGrants.attempt, row.attempt),
    ),
  );
  const grantByKey = new Map<string, (typeof grants)[number]>();
  for (const grant of grants) {
    if (grant.kind === "artifact") {
      grantByKey.set(grant.key, grant);
    }
  }

  const values: (typeof artifacts.$inferInsert)[] = [];
  let batchTotal = 0;
  for (const artifact of artifacts_) {
    const key = normalizeArtifactKey(artifact.key);
    const grant = grantByKey.get(key);
    if (!grant) {
      throw new DomainValidationError(
        "artifact_not_granted",
        `artifact '${key}' was not granted by the current upload batch for this StepRun`,
      );
    }
    if (artifact.sizeBytes > grant.sizeBytes) {
      throw new DomainValidationError(
        "artifact_size_exceeds_grant",
        `artifact '${key}' reports ${artifact.sizeBytes} bytes but only ${grant.sizeBytes} was declared at URL-mint time`,
      );
    }
    if (artifact.sizeBytes > MAX_ARTIFACT_BYTES) {
      throw new DomainValidationError(
        "artifact_too_large",
        `artifact '${key}' is ${artifact.sizeBytes} bytes, over the ${MAX_ARTIFACT_BYTES}-byte per-artifact quota`,
      );
    }
    if (!isArtifactKind(artifact.kind)) {
      throw new DomainValidationError("artifact_kind_invalid", `artifact '${key}' has unknown kind '${artifact.kind}'`);
    }
    batchTotal += artifact.sizeBytes;
    if (batchTotal > MAX_STEPRUN_ARTIFACT_BYTES) {
      throw new DomainValidationError(
        "artifact_quota_exceeded",
        `this turn records ${batchTotal} bytes of artifacts, over the ${MAX_STEPRUN_ARTIFACT_BYTES}-byte per-StepRun quota`,
      );
    }
    values.push({
      id: generateId("artifact"),
      stepRunId: row.id,
      key,
      kind: artifact.kind,
      contentType: artifact.contentType,
      blobKey: grant.blobKey,
      sizeBytes: artifact.sizeBytes,
      createdAt: now,
    });
  }
  await tx.insert(artifacts).values(values);
}

/**
 * Ends a turn successfully or with failure. Idempotency keys on
 * `lease_token` itself, not a new field (spec: "nol kunci baru ... `/result`
 * dijaga lease_token itu sendiri"): the same token replays the previously
 * recorded outcome at `200`; the row having moved on (a different token now
 * current, or `cancelled`) is `409`, and the Runner is fenced.
 *
 * The terminal transition and the Graph advance it triggers happen in **one
 * Postgres transaction**: the StepRun's `/result` commit, the fan-out
 * decision (issue #11 — a fan-out source's branches are born here, "cabang
 * lahir saat hulu sukses, keduanya dalam satu transaksi"), the Join
 * verdicts, skip propagation, and — the moment nothing is left in flight —
 * the Run's single write of `outcome`/`ended_at`. On a first-time commit
 * (never on an idempotent replay), `advanceGraph` re-evaluates every Step
 * that depends on this one from the opposite end (a Step finishing instead
 * of a Run starting); see `graph-advance.ts` for the full model.
 *
 * The invariant of the turn's commit point (spec: "push branch → unggah blob
 * → POST result ... StepRun `succeeded` ada ⇒ ref ada") is enforced here,
 * authoritatively: a `succeeded` result without a `ref` is a
 * `DomainValidationError` (400), not a stored row. A `failed` result may
 * carry an optional `ref` — the branch may have been pushed before the turn
 * went sideways (spec: "ref opsional bila branch sempat terdorong").
 *
 * Artifact metadata rides the final request (spec: "Metadata Artifact
 * menumpang request akhir itu"), committed in the same transaction as the
 * row update so a refused artifact batch voids the whole turn; only a
 * `succeeded` outcome records artifacts — a failed turn's branch is an
 * orphan and its artifacts are deliberately not shown ("Output yang ditolak
 * membuat seluruh giliran seolah tidak pernah terjadi").
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

  const [run] = await deps.db.select().from(runs).where(eq(runs.id, row.runId));
  if (!run) {
    throw new LeaseConflictError("step run references a missing run");
  }

  // The authoritative Output gate (AC6/AC7). The Runner may have validated
  // for live feedback while the session was still alive; this is where the
  // Output is allowed or rejected for good, because it is the only thing
  // that moves scheduling. A rejected Output makes the whole turn `failed`
  // with `reason: output-invalid`, consuming the ordinary attempt — the
  // branch it already pushed is an orphan for the retention GC.
  let outcome: "succeeded" | "failed" = input.outcome;
  let reason = input.reason ?? null;
  let outputData: unknown = input.outputData;
  if (input.outcome === "succeeded") {
    const checked = checkStepOutput(run.definition, row.stepKey, input.outputData);
    if (checked.kind === "invalid") {
      outcome = "failed";
      reason = "output-invalid";
      outputData = null;
    }
  }

  // The parsed Pipeline this Run's snapshot carries — used by the advance to
  // re-evaluate the Graph. A re-validation failure here is a control-plane
  // inconsistency (the definition validated at trigger); the terminal commit
  // still stands, the advance just does nothing.
  const pipeline = parsePipelineSnapshot(run.definition);

  const updated = await deps.db.transaction(async (tx) => {
    if (outcome === "succeeded") {
      await recordArtifacts(tx, deps.clock.now(), row, input.artifacts ?? []);
    }
    const [committed] = await tx
      .update(stepRuns)
      .set({
        outcome,
        reason,
        outputRefBranch: input.ref?.branch ?? null,
        outputRefSha: input.ref?.sha ?? null,
        outputData: outputData ?? null,
      })
      .where(eq(stepRuns.id, stepRunId))
      .returning();

    if (committed && pipeline) {
      await advanceGraph({ db: tx, now: deps.clock.now }, run, pipeline, row.stepKey);
      await finalizeRunIfDone({ db: tx, now: deps.clock.now }, run.id, pipeline);
    }
    return committed;
  });

  // The batch is consumed by this commit point — whether it recorded
  // artifacts or not, no later /uploads for this attempt may reference it.
  await clearGrants(deps, row);

  return toResultRecord(updated!);
}

/** Removes the grant batch of one (StepRun, attempt) — a batch is consumed the moment its turn commits. */
async function clearGrants(
  deps: Pick<AppDeps, "db">,
  row: StepRunRow,
): Promise<void> {
  await deps.db
    .delete(stepRunUploadGrants)
    .where(
      and(eq(stepRunUploadGrants.stepRunId, row.id), eq(stepRunUploadGrants.attempt, row.attempt)),
    );
}
