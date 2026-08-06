/**
 * The cost aggregation surface (issue 12, spec: "Cost"). Three separate GETs —
 * per-StepRun (with the per-attempt breakdown), per-Run (running cost while
 * in flight), and per-Project (explicitly a lower bound) — deliberately not
 * riding the 3-second list poll (spec: "Tiga agregasi saja, di endpoint
 * terpisah yang tidak menumpang poll"). A web-surface route like
 * `step-run-logs.ts`: session `Principal`, `camelCase`, no `db` reach —
 * every read goes through `deps.domain.costs.*`, which guards on Project
 * membership.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { errorResponseSchema, type Id } from "@factory/shared";
import type { AppEnv } from "../http-env.js";
import type { RouteDeps } from "../domain/index.js";
import { requirePrincipal } from "./require-principal.js";

const stepRunIdParamSchema = z.object({ id: z.string().openapi({ param: { name: "id", in: "path" } }) });
const projectIdParamSchema = z.object({ id: z.string().openapi({ param: { name: "id", in: "path" } }) });
const runIdParamSchema = z.object({
  id: z.string().openapi({ param: { name: "id", in: "path" } }),
  runId: z.string().openapi({ param: { name: "runId", in: "path" } }),
});

const attemptCostSchema = z
  .object({
    attempt: z.number().int().positive(),
    /** False when the agent reported no usage — the UI renders "tidak didukung", never an estimate. */
    supported: z.boolean(),
    tokens: z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() }).nullable(),
    costUsd: z.string().nullable(),
    /** The `price_versions` row this cost was priced against — a later price change never rewrites it. */
    priceVersion: z.string().nullable(),
  })
  .openapi("AttemptCost");

const stepRunCostResponseSchema = z
  .object({
    totalCostUsd: z.string().nullable(),
    attempts: z.array(attemptCostSchema),
  })
  .openapi("StepRunCost");

const runCostResponseSchema = z
  .object({
    totalCostUsd: z.string().nullable(),
    supportedAttempts: z.number().int().nonnegative(),
    unsupportedAttempts: z.number().int().nonnegative(),
    credentialPrincipalId: z.string(),
    /** False while the Run is in flight — the cost shown is then the *running* cost (AC8). */
    runEnded: z.boolean(),
  })
  .openapi("RunCost");

const projectCostPrincipalSchema = z
  .object({
    credentialPrincipalId: z.string(),
    costUsd: z.string(),
  })
  .openapi("ProjectCostPrincipal");

const projectCostResponseSchema = z
  .object({
    totalCostUsd: z.string().nullable(),
    /** Always true — the total is a lower bound, never the full spend (unsupported agents and in-flight Runs contribute nothing). */
    lowerBound: z.literal(true),
    byCredentialPrincipal: z.array(projectCostPrincipalSchema),
  })
  .openapi("ProjectCost");

const stepRunCostRoute = createRoute({
  method: "get",
  path: "/step-runs/{id}/cost",
  summary:
    "One StepRun's cost with the per-attempt breakdown (issue 12, AC6). A retried StepRun has one row per attempt; the cumulative total is a plain sum. An attempt whose agent reported no usage is `supported: false` — shown as 'tidak didukung', never estimated. Project member.",
  request: { params: stepRunIdParamSchema },
  responses: {
    200: {
      description: "Ok.",
      content: { "application/json": { schema: stepRunCostResponseSchema } },
    },
    401: { description: "Not logged in.", content: { "application/json": { schema: errorResponseSchema } } },
    403: { description: "Not a Project member.", content: { "application/json": { schema: errorResponseSchema } } },
    404: { description: "No such step run.", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

const runCostRoute = createRoute({
  method: "get",
  path: "/projects/{id}/runs/{runId}/cost",
  summary:
    "One Run's cost (issue 12, AC8). While the Run is in flight (`runEnded: false`) this is the running cost — the sum of completed attempts so far — which the run-detail screen (the one with the cancel button) shows live. Project member.",
  request: { params: runIdParamSchema },
  responses: {
    200: {
      description: "Ok.",
      content: { "application/json": { schema: runCostResponseSchema } },
    },
    401: { description: "Not logged in.", content: { "application/json": { schema: errorResponseSchema } } },
    403: { description: "Not a Project member.", content: { "application/json": { schema: errorResponseSchema } } },
    404: { description: "No such Project or Run.", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

const projectCostRoute = createRoute({
  method: "get",
  path: "/projects/{id}/cost",
  summary:
    "The Project's cost across every Run (issue 12, AC2/AC9). Explicitly a *lower bound*, never a total: agents that reported no usage and Runs still in flight contribute nothing, and the price table is pinned to what was already written. Broken down by the credential principal each Run used, so shared-credential usage is visible. Project member.",
  request: { params: projectIdParamSchema },
  responses: {
    200: {
      description: "Ok.",
      content: { "application/json": { schema: projectCostResponseSchema } },
    },
    401: { description: "Not logged in.", content: { "application/json": { schema: errorResponseSchema } } },
    403: { description: "Not a Project member.", content: { "application/json": { schema: errorResponseSchema } } },
    404: { description: "No such Project.", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

export function registerCostRoutes(app: OpenAPIHono<AppEnv>, deps: RouteDeps): void {
  app.openapi(stepRunCostRoute, async (c) => {
    const principal = requirePrincipal(c);
    const { id } = c.req.valid("param");
    const cost = await deps.domain.costs.stepRun(principal, id as Id<"steprun">);
    return c.json(
      {
        totalCostUsd: cost.totalCostUsd,
        attempts: cost.attempts.map((attempt) => ({
          attempt: attempt.attempt,
          supported: attempt.supported,
          tokens: attempt.tokens,
          costUsd: attempt.costUsd,
          priceVersion: attempt.priceVersion,
        })),
      },
      200,
    );
  });

  app.openapi(runCostRoute, async (c) => {
    const principal = requirePrincipal(c);
    const { id: projectId, runId } = c.req.valid("param");
    const cost = await deps.domain.costs.run(principal, projectId as Id<"project">, runId as Id<"run">);
    return c.json(
      {
        totalCostUsd: cost.totalCostUsd,
        supportedAttempts: cost.supportedAttempts,
        unsupportedAttempts: cost.unsupportedAttempts,
        credentialPrincipalId: cost.credentialPrincipalId,
        runEnded: cost.runEnded,
      },
      200,
    );
  });

  app.openapi(projectCostRoute, async (c) => {
    const principal = requirePrincipal(c);
    const { id: projectId } = c.req.valid("param");
    const cost = await deps.domain.costs.project(principal, projectId as Id<"project">);
    return c.json(
      {
        totalCostUsd: cost.totalCostUsd,
        lowerBound: true as const,
        byCredentialPrincipal: cost.byCredentialPrincipal.map((row) => ({
          credentialPrincipalId: row.credentialPrincipalId,
          costUsd: row.costUsd,
        })),
      },
      200,
    );
  });
}
