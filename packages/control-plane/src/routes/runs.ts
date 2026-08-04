/**
 * Trigger a Pipeline, list Runs, and read one Run's Graph. Same shape as
 * every other route file: resolve the caller with `requirePrincipal`, hand
 * it to `deps.domain.runs` as the first argument, and never touch `runs` /
 * `step_runs` directly — `RouteDeps` carries no `db` (see `domain/index.ts`).
 */
import { createHash } from "node:crypto";
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { errorResponseSchema, type Id } from "@factory/shared";
import type { AppEnv } from "../http-env.js";
import type { RouteDeps } from "../domain/index.js";
import type { Run, RunListFilters, StepRun } from "../domain/runs.js";
import { requirePrincipal } from "./require-principal.js";

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;

const projectIdParamSchema = z.object({ id: z.string().openapi({ param: { name: "id", in: "path" } }) });
const runIdParamSchema = z.object({
  id: z.string().openapi({ param: { name: "id", in: "path" } }),
  runId: z.string().openapi({ param: { name: "runId", in: "path" } }),
});

const runSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    pipelineRepositoryId: z.string(),
    pipelinePath: z.string(),
    triggerKind: z.enum(["automation", "manual"]),
    triggeredByPrincipalId: z.string(),
    credentialPrincipalId: z.string(),
    refBranch: z.string(),
    refSha: z.string(),
    parentRunId: z.string().nullable(),
    cancelRequestedAt: z.string().nullable(),
    outcome: z.enum(["succeeded", "failed", "cancelled"]).nullable(),
    endedAt: z.string().nullable(),
  })
  .openapi("Run");

const runDetailSchema = runSchema
  .extend({
    definition: z.string(),
    definitionFiles: z.record(z.string(), z.string()),
  })
  .openapi("RunDetail");

const stepRunSchema = z
  .object({
    id: z.string(),
    runId: z.string(),
    repositoryId: z.string(),
    stepKey: z.string(),
    branchKey: z.string().nullable(),
    turn: z.number(),
    attempt: z.number(),
    outcome: z.enum(["ready", "running", "awaiting-human", "succeeded", "failed", "skipped", "cancelled"]),
    reason: z.string().nullable(),
    kind: z.literal("pull-request").nullable(),
    requiredTags: z.array(z.string()),
    readyAt: z.string(),
    startedAt: z.string().nullable(),
    outputRefBranch: z.string().nullable(),
    outputRefSha: z.string().nullable(),
    outputData: z.unknown().nullable(),
    // The PR a kind: pull-request StepRun opened, recorded on its row (issue 17).
    prNumber: z.number().int().nullable(),
    prUrl: z.string().nullable(),
    // Prompt final yang benar-benar dikirim ke agent (issue 9, AC5) — isi
    // file + blok instruksi format. NULL sebelum giliran diklaim.
    finalPrompt: z.string().nullable(),
  })
  .openapi("StepRun");

const triggerRunBodySchema = z.object({
  id: z.string().min(1).openapi({ description: "Client-generated Run id; a repeat of the same id is rejected by the primary key." }),
  repositoryId: z.string().min(1),
  pipelinePath: z.string().min(1),
  refBranch: z.string().min(1),
});

function toRunResponse(run: Run) {
  return {
    id: run.id,
    projectId: run.projectId,
    pipelineRepositoryId: run.pipelineRepositoryId,
    pipelinePath: run.pipelinePath,
    triggerKind: run.triggerKind,
    triggeredByPrincipalId: run.triggeredByPrincipalId,
    credentialPrincipalId: run.credentialPrincipalId,
    refBranch: run.refBranch,
    refSha: run.refSha,
    parentRunId: run.parentRunId,
    cancelRequestedAt: run.cancelRequestedAt?.toISOString() ?? null,
    outcome: run.outcome,
    endedAt: run.endedAt?.toISOString() ?? null,
  };
}

function toRunDetailResponse(run: Run, definitionText: string, definitionFiles: Record<string, string>) {
  return { ...toRunResponse(run), definition: definitionText, definitionFiles };
}

function toStepRunResponse(stepRun: StepRun) {
  return {
    id: stepRun.id,
    runId: stepRun.runId,
    repositoryId: stepRun.repositoryId,
    stepKey: stepRun.stepKey,
    branchKey: stepRun.branchKey,
    turn: stepRun.turn,
    attempt: stepRun.attempt,
    outcome: stepRun.outcome,
    reason: stepRun.reason,
    kind: stepRun.kind,
    requiredTags: stepRun.requiredTags,
    readyAt: stepRun.readyAt.toISOString(),
    startedAt: stepRun.startedAt?.toISOString() ?? null,
    outputRefBranch: stepRun.outputRefBranch,
    outputRefSha: stepRun.outputRefSha,
    outputData: stepRun.outputData,
    prNumber: stepRun.prNumber,
    prUrl: stepRun.prUrl,
    finalPrompt: stepRun.finalPrompt,
  };
}

const triggerRunRoute = createRoute({
  method: "post",
  path: "/projects/{id}/runs",
  summary:
    "Triggers a Pipeline over a ref. Reads the definition (and every prompt file it references) from that ref, validates, and — if valid — materializes the Run and its initial Graph in one transaction. Project `member`.",
  request: {
    params: projectIdParamSchema,
    body: { content: { "application/json": { schema: triggerRunBodySchema } } },
  },
  responses: {
    201: {
      description: "Created. `stepRuns` holds the Steps materialized up front — see the Run's `definition` for the rest of the Graph's shape.",
      content: { "application/json": { schema: z.object({ run: runSchema, stepRuns: z.array(stepRunSchema) }) } },
    },
    400: {
      description:
        "Rejected before any row was written: an unknown ref, a missing definition or prompt file, a definition that fails validation, the combined size over the inline-storage limit, an unknown Step repo:, or a repeated Run id.",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    401: { description: "Not logged in.", content: { "application/json": { schema: errorResponseSchema } } },
    403: { description: "Not a Project member.", content: { "application/json": { schema: errorResponseSchema } } },
    404: { description: "No such Project or Repository.", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

const listRunsRoute = createRoute({
  method: "get",
  path: "/projects/{id}/runs",
  summary:
    "Runs for a Project, newest first. Keyset pagination on id — no total count. `inFlight=true` filters ended_at IS NULL; `outcome=` filters a final verdict; the two are never combined.",
  request: {
    params: projectIdParamSchema,
    query: z.object({
      cursor: z.string().optional(),
      limit: z.string().optional(),
      inFlight: z.enum(["true"]).optional(),
      outcome: z.enum(["succeeded", "failed", "cancelled"]).optional(),
    }),
  },
  responses: {
    200: {
      description: "Ok.",
      content: {
        "application/json": {
          schema: z.object({ runs: z.array(runSchema), nextCursor: z.string().nullable() }),
        },
      },
    },
    401: { description: "Not logged in.", content: { "application/json": { schema: errorResponseSchema } } },
    403: { description: "Not a Project member.", content: { "application/json": { schema: errorResponseSchema } } },
    404: { description: "No such Project.", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

const getRunRoute = createRoute({
  method: "get",
  path: "/projects/{id}/runs/{runId}",
  summary: "One Run: its own copy of the definition and prompt files, plus its Graph so far.",
  request: { params: runIdParamSchema },
  responses: {
    200: {
      description: "Ok.",
      headers: {
        ETag: { description: "Opaque version for conditional Graph polling.", schema: { type: "string" } },
      },
      content: {
        "application/json": {
          schema: z.object({ run: runDetailSchema, stepRuns: z.array(stepRunSchema) }),
        },
      },
    },
    304: {
      description: "Not modified. The response has no body.",
      headers: {
        ETag: { description: "The unchanged Graph version.", schema: { type: "string" } },
      },
    },
    401: { description: "Not logged in.", content: { "application/json": { schema: errorResponseSchema } } },
    403: { description: "Not a Project member.", content: { "application/json": { schema: errorResponseSchema } } },
    404: { description: "No such Project or Run.", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

const cancelRunRoute = createRoute({
  method: "post",
  path: "/projects/{id}/runs/{runId}/cancel",
  summary:
    "Records cancel_requested_at immediately as operator intent. StepRun cancellation follows through the Runner heartbeat channel; repeating the request is idempotent. Project member.",
  request: { params: runIdParamSchema },
  responses: {
    200: {
      description: "Cancellation intent recorded (or already present).",
      content: { "application/json": { schema: z.object({ run: runSchema }) } },
    },
    401: { description: "Not logged in.", content: { "application/json": { schema: errorResponseSchema } } },
    403: { description: "Not a Project member.", content: { "application/json": { schema: errorResponseSchema } } },
    404: { description: "No such Project or Run.", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

function graphEtag(run: ReturnType<typeof toRunResponse>, stepRuns: ReturnType<typeof toStepRunResponse>[]): string {
  const stableStepRuns = [...stepRuns].sort((a, b) => a.id.localeCompare(b.id));
  const digest = createHash("sha256")
    .update(JSON.stringify({ run, stepRuns: stableStepRuns }))
    .digest("hex");
  return `"${digest}"`;
}

export function registerRunRoutes(app: OpenAPIHono<AppEnv>, deps: RouteDeps): void {
  app.openapi(triggerRunRoute, async (c) => {
    const principal = requirePrincipal(c);
    const { id: projectId } = c.req.valid("param");
    const body = c.req.valid("json");
    const { run, stepRuns } = await deps.domain.runs.trigger(principal, projectId as Id<"project">, {
      id: body.id as Id<"run">,
      repositoryId: body.repositoryId as Id<"repository">,
      pipelinePath: body.pipelinePath,
      refBranch: body.refBranch,
    });
    return c.json({ run: toRunResponse(run), stepRuns: stepRuns.map(toStepRunResponse) }, 201);
  });

  app.openapi(listRunsRoute, async (c) => {
    const principal = requirePrincipal(c);
    const { id: projectId } = c.req.valid("param");
    const query = c.req.valid("query");
    const limit = Math.min(query.limit ? Number(query.limit) : DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    const filters: RunListFilters = { inFlight: query.inFlight === "true" };
    if (query.outcome) {
      filters.outcome = query.outcome;
    }
    const { runs, nextCursor } = await deps.domain.runs.list(
      principal,
      projectId as Id<"project">,
      filters,
      (query.cursor as Id<"run"> | undefined) ?? null,
      limit,
    );
    return c.json({ runs: runs.map(toRunResponse), nextCursor }, 200);
  });

  app.openapi(getRunRoute, async (c) => {
    const principal = requirePrincipal(c);
    const { id: projectId, runId } = c.req.valid("param");
    const { run, stepRuns } = await deps.domain.runs.get(principal, projectId as Id<"project">, runId as Id<"run">);
    const definitionText = run.definition as string;
    const definitionFiles = run.definitionFiles as Record<string, string>;
    const runResponse = toRunDetailResponse(run, definitionText, definitionFiles);
    const stepRunResponses = stepRuns.map(toStepRunResponse);
    const etag = graphEtag(runResponse, stepRunResponses);
    c.header("ETag", etag);
    if (c.req.header("if-none-match") === etag) {
      return c.body(null, 304);
    }
    return c.json({ run: runResponse, stepRuns: stepRunResponses }, 200);
  });

  app.openapi(cancelRunRoute, async (c) => {
    const principal = requirePrincipal(c);
    const { id: projectId, runId } = c.req.valid("param");
    const run = await deps.domain.runs.cancel(principal, projectId as Id<"project">, runId as Id<"run">);
    return c.json({ run: toRunResponse(run) }, 200);
  });
}
