/**
 * The nine POST endpoints, zero GET, that make up the Runner <-> control
 * plane contract (spec: "Kontrak API control-plane <-> Runner"). The Runner
 * never asks the world anything — every field below is exactly what the
 * spec's wire format names, in the spec's own `snake_case` (deliberately
 * different from the web <-> control-plane surface's `camelCase`; see the
 * written report for why keeping the two conventions apart, rather than
 * picking one for the whole codebase, was the call made here).
 *
 * Every handler below does the same three things in the same order: resolve
 * the caller via `requireRunner` (or, for `/join`, none yet), call exactly
 * one `deps.domain.stepRuns.*` / `deps.domain.runners.*` function, and shape
 * the reply. No handler reaches `db` — see `domain/index.ts`.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { errorResponseSchema, isValidId, joinManifestEntrySchema } from "@factory/shared";
import type { AppEnv } from "../http-env.js";
import type { RouteDeps } from "../domain/index.js";
import { ClaimCapacityError } from "../domain/index.js";
import { requireRunner } from "./require-runner.js";

const joinRequestSchema = z.object({ token: z.string().min(1) }).openapi("RunnerJoinRequest");
const joinResponseSchema = z
  .object({ runner_id: z.string(), secret: z.string() })
  .openapi("RunnerJoinResponse");

const joinRoute = createRoute({
  method: "post",
  path: "/join",
  summary: "Exchanges a single-use join token for a runner id + bearer secret. The Runner writes both to a file on disk — never a hostname or IP carries identity (spec).",
  request: { body: { content: { "application/json": { schema: joinRequestSchema } } } },
  responses: {
    200: { description: "Joined.", content: { "application/json": { schema: joinResponseSchema } } },
    401: { description: "Token invalid, unknown, or already used.", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

const claimRequestSchema = z
  .object({
    tags: z.array(z.string()),
    slots: z.number().int().positive(),
    protocol_version: z.number().int(),
  })
  .openapi("ClaimRequest");

const gitTokenSchema = z
  .object({
    token: z.string(),
    expires_at: z.string(),
    repository_ids: z.array(z.number().int()),
    permissions: z.record(z.string(), z.string()),
  })
  .openapi("GitToken");

const claimedStepRunSchema = z.object({
  id: z.string(),
  run_id: z.string(),
  step_key: z.string(),
  branch_key: z.string().nullable(),
  turn: z.number(),
  attempt: z.number(),
  repository: z.object({ id: z.string(), owner: z.string(), name: z.string(), default_branch: z.string() }),
  ref: z.object({ branch: z.string(), sha: z.string() }),
  definition: z.unknown(),
  definition_files: z.unknown(),
  lease_token: z.string(),
  lease_expires_at: z.string(),
  git_tokens: z.object({ fetch: gitTokenSchema, push: gitTokenSchema }),
  // Resolved at scheduling (spec: "secret di-resolve saat penjadwalan") for
  // the Run's credential Principal; the Runner hands these to the agent call
  // and never writes them to a file inside the sandbox (AC5).
  secrets: z.record(z.string(), z.string()),
  // Default-deny egress allowlist for the sandbox (AC6).
  egress_allowlist: z.array(z.string()),
  // The Group an interactive Step's ask: addresses, resolved here (spec:
  // "semua yang ia butuh ikut di muatan /claim"). Null for non-interactive
  // Steps.
  ask_group_id: z.string().nullable(),
  // The Join manifest (issue #11, AC7): the upstream branches this Join Step
  // gathers, as data — empty for a Step that joins nothing. The Runner
  // fetches only the entries whose `repo` is its own; the rest are reads,
  // never checkouts (ticket 21).
  join_manifest: z.array(joinManifestEntrySchema),
});
const claimResponseSchema = z.object({ step_run: claimedStepRunSchema.nullable() }).openapi("ClaimResponse");

const claimRoute = createRoute({
  method: "post",
  path: "/claim",
  summary:
    "Long-polls for up to a server-randomized 20-30s (spec). 200 with `step_run: null` when the hold elapses with nothing to claim — that is not an error. 426 outside the supported protocol range; 503 + Retry-After above the hanging-connection cap.",
  request: { body: { content: { "application/json": { schema: claimRequestSchema } } } },
  responses: {
    200: { description: "Claimed, or nothing available.", content: { "application/json": { schema: claimResponseSchema } } },
    401: { description: "Bad or revoked secret.", content: { "application/json": { schema: errorResponseSchema } } },
    426: { description: "Protocol version out of range.", content: { "application/json": { schema: errorResponseSchema } } },
    503: { description: "Too many hanging connections.", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

const heartbeatRequestSchema = z
  .object({
    leases: z.array(z.object({ step_run_id: z.string(), lease_token: z.string() })),
    caps_hash: z.string().nullable().optional(),
    free_slots: z.number().int().nonnegative().optional(),
    protocol_version: z.number().int().optional(),
  })
  .openapi("HeartbeatRequest");

const heartbeatResponseSchema = z
  .object({
    desired_state: z.enum(["active", "draining", "revoked"]),
    cancel: z.array(z.string()),
    unknown_leases: z.array(z.string()),
    caps_stale: z.boolean(),
    latest_release: z.string(),
    protocol: z.object({ min: z.number(), max: z.number() }),
  })
  .openapi("HeartbeatResponse");

const heartbeatRoute = createRoute({
  method: "post",
  path: "/heartbeat",
  summary:
    "The only command channel. Always 200, even outside the supported protocol range (spec) — a healthy-but-permanently-idle Runner still needs somewhere to be seen by an operator. `unknown_leases` and `cancel` are always disjoint lists with different meanings.",
  request: { body: { content: { "application/json": { schema: heartbeatRequestSchema } } } },
  responses: {
    200: { description: "Always.", content: { "application/json": { schema: heartbeatResponseSchema } } },
    401: { description: "Bad or revoked secret.", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

const capabilitiesRequestSchema = z
  .object({
    caps_hash: z.string().min(1),
    capabilities: z.unknown(),
    release_version: z.string().optional(),
  })
  .openapi("CapabilitiesReportRequest");

const capabilitiesRoute = createRoute({
  method: "post",
  path: "/runners/me/capabilities",
  summary: "Full capabilities report, sent when the Runner's locally-computed caps_hash no longer matches what the last heartbeat reply confirmed (`caps_stale`).",
  request: { body: { content: { "application/json": { schema: capabilitiesRequestSchema } } } },
  responses: {
    200: { description: "Recorded.", content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } } },
    401: { description: "Bad or revoked secret.", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

const selfDrainRoute = createRoute({
  method: "post",
  path: "/runners/me/drain",
  summary: "CLI-local write of desired_state='draining' — the Runner asking to stop taking new work while finishing what it holds. See /runners/{id}/drain for the operator/UI path into the same column.",
  request: { body: { content: { "application/json": { schema: z.object({}) } } } },
  responses: {
    200: { description: "Draining.", content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } } },
    401: { description: "Bad or revoked secret.", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

const stepRunIdParamSchema = z.object({ id: z.string().openapi({ param: { name: "id", in: "path" } }) });

const uploadsRequestSchema = z
  .object({
    lease_token: z.string(),
    requests: z.array(z.object({ key: z.string().min(1), kind: z.enum(["artifact", "session", "log"]) })).max(64),
  })
  .openapi("UploadGrantRequest");
const uploadsResponseSchema = z
  .object({
    grants: z.array(z.object({ key: z.string(), upload_url: z.string(), expires_at: z.string() })),
  })
  .openapi("UploadGrantResponse");

const uploadsRoute = createRoute({
  method: "post",
  path: "/step-runs/{id}/uploads",
  summary: "Mints presigned PUT grants for this turn's artifacts/session — replaces the previous grant list rather than adding to it (spec).",
  request: { params: stepRunIdParamSchema, body: { content: { "application/json": { schema: uploadsRequestSchema } } } },
  responses: {
    200: { description: "Grants minted.", content: { "application/json": { schema: uploadsResponseSchema } } },
    401: { description: "Bad or revoked secret.", content: { "application/json": { schema: errorResponseSchema } } },
    409: { description: "Lease no longer valid.", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

const logChunksRequestSchema = z
  .object({
    lease_token: z.string(),
    chunks: z
      .array(
        z.object({
          attempt: z.number().int().positive(),
          seq: z.number().int().nonnegative(),
          blob_key: z.string().min(1),
          byte_offset: z.number().int().nonnegative(),
          size: z.number().int().nonnegative(),
        }),
      )
      .max(256),
  })
  .openapi("LogChunksRequest");

const logChunksRoute = createRoute({
  method: "post",
  path: "/step-runs/{id}/log-chunks",
  summary: "Records log chunk metadata, batch. Dedup at the primary key (step_run_id, attempt, seq), not in application code.",
  request: { params: stepRunIdParamSchema, body: { content: { "application/json": { schema: logChunksRequestSchema } } } },
  responses: {
    200: { description: "Recorded.", content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } } },
    401: { description: "Bad or revoked secret.", content: { "application/json": { schema: errorResponseSchema } } },
    409: { description: "Lease no longer valid.", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

const questionSchema = z.object({
  id: z.string().refine((id) => isValidId("question", id), { message: "must be a valid question_ id" }),
  group_id: z.string(),
  kind: z.enum(["text", "choice", "approval", "edit-artifact"]),
  body: z.string().max(64 * 1024),
  options: z.array(z.object({ id: z.string(), label: z.string(), description: z.string().optional() })).optional(),
  multi: z.boolean().optional(),
  allow_other: z.boolean().optional(),
  artifact_key: z.string().optional(),
});

const questionRequestSchema = z
  .object({
    lease_token: z.string(),
    question: questionSchema,
    ref: z.object({ branch: z.string(), sha: z.string() }),
    session_blob_key: z.string().optional(),
  })
  .openapi("QuestionRequest");

const questionRoute = createRoute({
  method: "post",
  path: "/step-runs/{id}/question",
  summary: "The commit point of a turn that ends by asking a human. Moves the StepRun to awaiting-human without a lease.",
  request: { params: stepRunIdParamSchema, body: { content: { "application/json": { schema: questionRequestSchema } } } },
  responses: {
    200: { description: "Published.", content: { "application/json": { schema: z.object({ question_id: z.string() }) } } },
    401: { description: "Bad or revoked secret.", content: { "application/json": { schema: errorResponseSchema } } },
    409: { description: "Lease no longer valid.", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

const resultRequestSchema = z
  .object({
    lease_token: z.string(),
    outcome: z.enum(["succeeded", "failed"]),
    ref: z.object({ branch: z.string(), sha: z.string() }).optional(),
    output_data: z.unknown().optional(),
    reason: z.string().optional(),
  })
  .openapi("ResultRequest");
const resultResponseSchema = z
  .object({
    outcome: z.enum(["succeeded", "failed"]),
    ref: z.object({ branch: z.string(), sha: z.string() }).nullable(),
    output_data: z.unknown(),
  })
  .openapi("ResultResponse");

const resultRoute = createRoute({
  method: "post",
  path: "/step-runs/{id}/result",
  summary:
    "The commit point of a turn that ends succeeded/failed. Idempotent on lease_token itself: the same token replays the recorded outcome at 200; a stale one (superseded by a sweep, or the row was cancelled) is 409 and the Runner is fenced.",
  request: { params: stepRunIdParamSchema, body: { content: { "application/json": { schema: resultRequestSchema } } } },
  responses: {
    200: { description: "Recorded (or replayed).", content: { "application/json": { schema: resultResponseSchema } } },
    401: { description: "Bad or revoked secret.", content: { "application/json": { schema: errorResponseSchema } } },
    409: { description: "Lease no longer valid — cancelled, or superseded by another claim.", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

export function registerRunnerProtocolRoutes(app: OpenAPIHono<AppEnv>, deps: RouteDeps): void {
  app.openapi(joinRoute, async (c) => {
    const { token } = c.req.valid("json");
    const { runnerId, secret } = await deps.domain.runners.join(token);
    return c.json({ runner_id: runnerId, secret }, 200);
  });

  app.openapi(claimRoute, async (c) => {
    const runner = await requireRunner(c, deps);
    const { tags, slots, protocol_version } = c.req.valid("json");
    let claimed;
    try {
      claimed = await deps.domain.stepRuns.claim(runner, { tags, slots, protocolVersion: protocol_version });
    } catch (error) {
      if (error instanceof ClaimCapacityError) {
        c.header("Retry-After", "5");
        return c.json({ code: "claim_capacity_exceeded", message: error.message }, 503);
      }
      throw error;
    }
    if (!claimed) {
      return c.json({ step_run: null }, 200);
    }
    const toTokenWire = (token: { token: string; expiresAt: Date; repositoryIds: number[]; permissions: Record<string, string> }) => ({
      token: token.token,
      expires_at: token.expiresAt.toISOString(),
      repository_ids: token.repositoryIds,
      permissions: token.permissions,
    });
    return c.json(
      {
        step_run: {
          id: claimed.id,
          run_id: claimed.runId,
          step_key: claimed.stepKey,
          branch_key: claimed.branchKey,
          turn: claimed.turn,
          attempt: claimed.attempt,
          repository: {
            id: claimed.repository.id,
            owner: claimed.repository.owner,
            name: claimed.repository.name,
            default_branch: claimed.repository.defaultBranch,
          },
          ref: claimed.ref,
          definition: claimed.definition,
          definition_files: claimed.definitionFiles,
          lease_token: claimed.leaseToken,
          lease_expires_at: claimed.leaseExpiresAt.toISOString(),
          git_tokens: { fetch: toTokenWire(claimed.gitTokens.fetch), push: toTokenWire(claimed.gitTokens.push) },
          secrets: claimed.secrets,
          egress_allowlist: claimed.egressAllowlist,
          ask_group_id: claimed.askGroupId,
          join_manifest: claimed.joinManifest,
        },
      },
      200,
    );
  });

  app.openapi(heartbeatRoute, async (c) => {
    const runner = await requireRunner(c, deps);
    const body = c.req.valid("json");
    const reply = await deps.domain.runners.heartbeat(runner, {
      leases: body.leases.map((lease) => ({ stepRunId: lease.step_run_id as never, leaseToken: lease.lease_token })),
      capsHash: body.caps_hash ?? null,
      protocolVersion: body.protocol_version ?? null,
    });
    return c.json(
      {
        desired_state: reply.desiredState,
        cancel: reply.cancel,
        unknown_leases: reply.unknownLeases,
        caps_stale: reply.capsStale,
        latest_release: reply.latestRelease,
        protocol: reply.protocol,
      },
      200,
    );
  });

  app.openapi(capabilitiesRoute, async (c) => {
    const runner = await requireRunner(c, deps);
    const { caps_hash, capabilities, release_version } = c.req.valid("json");
    await deps.domain.runners.reportCapabilities(runner, caps_hash, capabilities, release_version);
    return c.json({ ok: true as const }, 200);
  });

  app.openapi(selfDrainRoute, async (c) => {
    const runner = await requireRunner(c, deps);
    await deps.domain.runners.selfDrain(runner);
    return c.json({ ok: true as const }, 200);
  });

  app.openapi(uploadsRoute, async (c) => {
    const runner = await requireRunner(c, deps);
    const { id } = c.req.valid("param");
    const { lease_token, requests } = c.req.valid("json");
    const grants = await deps.domain.stepRuns.mintUploadGrants(
      runner,
      id as never,
      lease_token,
      requests.map((r) => ({ key: r.key, kind: r.kind })),
    );
    return c.json(
      { grants: grants.map((g) => ({ key: g.key, upload_url: g.uploadUrl, expires_at: g.expiresAt.toISOString() })) },
      200,
    );
  });

  app.openapi(logChunksRoute, async (c) => {
    const runner = await requireRunner(c, deps);
    const { id } = c.req.valid("param");
    const { lease_token, chunks } = c.req.valid("json");
    await deps.domain.stepRuns.recordLogChunks(
      runner,
      id as never,
      lease_token,
      chunks.map((chunk) => ({
        attempt: chunk.attempt,
        seq: chunk.seq,
        blobKey: chunk.blob_key,
        byteOffset: chunk.byte_offset,
        size: chunk.size,
      })),
    );
    return c.json({ ok: true as const }, 200);
  });

  app.openapi(questionRoute, async (c) => {
    const runner = await requireRunner(c, deps);
    const { id } = c.req.valid("param");
    const { lease_token, question, ref, session_blob_key } = c.req.valid("json");
    const { questionId } = await deps.domain.stepRuns.submitQuestion(runner, id as never, lease_token, {
      id: question.id as never,
      groupId: question.group_id as never,
      kind: question.kind,
      body: question.body,
      options: question.options,
      multi: question.multi,
      allowOther: question.allow_other,
      artifactKey: question.artifact_key,
      ref,
      sessionBlobKey: session_blob_key,
    });
    return c.json({ question_id: questionId }, 200);
  });

  app.openapi(resultRoute, async (c) => {
    const runner = await requireRunner(c, deps);
    const { id } = c.req.valid("param");
    const { lease_token, outcome, ref, output_data, reason } = c.req.valid("json");
    const recorded = await deps.domain.stepRuns.submitResult(runner, id as never, lease_token, {
      outcome,
      ref,
      outputData: output_data,
      reason,
    });
    return c.json({ outcome: recorded.outcome, ref: recorded.ref, output_data: recorded.outputData }, 200);
  });
}
