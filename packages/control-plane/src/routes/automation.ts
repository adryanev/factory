/**
 * Automation's two HTTP surfaces: the GitHub App webhook (external, HMAC,
 * no session — the one place a raw body is handled) and the "cron yang
 * dilewati" list (web surface, Project `member`). Everything else about
 * Automation lives in the sweep; the webhook handler deliberately does as
 * little as possible (verify + drop into `webhook_deliveries` + 2xx).
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { errorResponseSchema, type Id } from "@factory/shared";
import type { AppEnv } from "../http-env.js";
import type { RouteDeps } from "../domain/index.js";
import { requirePrincipal } from "./require-principal.js";

/** The one path the GitHub App webhook posts to. CSRF-exempt like the Runner surface — a webhook has no cookie a foreign origin could ride. */
export const GITHUB_WEBHOOK_PATH = "/webhook/github";

const cronSkipSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    pipelineRepositoryId: z.string(),
    pipelinePath: z.string(),
    refBranch: z.string(),
    refSha: z.string(),
    scheduledFor: z.string(),
    skippedAt: z.string(),
    reason: z.enum(["run-active"]),
  })
  .openapi("CronSkip");

const projectIdParamSchema = z.object({ id: z.string().openapi({ param: { name: "id", in: "path" } }) });

const webhookRoute = createRoute({
  method: "post",
  path: GITHUB_WEBHOOK_PATH,
  summary:
    "The GitHub App webhook. Verifies the `x-hub-signature-256` HMAC, then drops the raw event into the dedup table (layer 1: `X-GitHub-Delivery` for 24h) and answers 202 — every mapping to Runs happens on the sweep, out of GitHub's request path. A redelivered delivery id is ack'ed and dropped. The body is the raw GitHub webhook payload; it is deliberately NOT schema'd here because the HMAC must be verified over the exact bytes — the handler reads the raw body itself.",
  responses: {
    202: { description: "Accepted (or a duplicate delivery, which is dropped)." },
    400: { description: "Missing delivery id or unparseable body.", content: { "application/json": { schema: errorResponseSchema } } },
    401: { description: "Bad HMAC signature — the payload was not signed by the configured webhook secret.", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

const listCronSkipsRoute = createRoute({
  method: "get",
  path: "/projects/{id}/automation/cron-skips",
  summary:
    "Cron fires that were skipped because a Run was already active for the same (Pipeline, ref) — the visible half of \"skip saat tumpang tindih\". Keyset on id DESC, newest first, no total count.",
  request: {
    params: projectIdParamSchema,
    query: z.object({
      cursor: z.string().optional(),
      limit: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Ok.",
      content: {
        "application/json": {
          schema: z.object({ skips: z.array(cronSkipSchema), nextCursor: z.string().nullable() }),
        },
      },
    },
    401: { description: "Not logged in.", content: { "application/json": { schema: errorResponseSchema } } },
    403: { description: "Not a Project member.", content: { "application/json": { schema: errorResponseSchema } } },
    404: { description: "No such Project.", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

const DEFAULT_SKIPS_LIMIT = 50;
const MAX_SKIPS_LIMIT = 200;

function toCronSkipResponse(skip: {
  id: string;
  projectId: string;
  pipelineRepositoryId: string;
  pipelinePath: string;
  refBranch: string;
  refSha: string;
  scheduledFor: Date;
  skippedAt: Date;
  reason: string;
}) {
  return {
    id: skip.id,
    projectId: skip.projectId,
    pipelineRepositoryId: skip.pipelineRepositoryId,
    pipelinePath: skip.pipelinePath,
    refBranch: skip.refBranch,
    refSha: skip.refSha,
    scheduledFor: skip.scheduledFor.toISOString(),
    skippedAt: skip.skippedAt.toISOString(),
    // The `cron_skips_reason_check` CHECK closes the set to 'run-active'.
    reason: skip.reason as "run-active",
  };
}

export function registerAutomationRoutes(app: OpenAPIHono<AppEnv>, deps: RouteDeps): void {
  app.openapi(webhookRoute, async (c) => {
    const rawBody = await c.req.raw.text();
    if (rawBody.length > 10 * 1024 * 1024) {
      return c.json({ code: "payload_too_large", message: "webhook body exceeds 10 MiB" }, 413);
    }
    const result = await deps.domain.automation.ingestWebhook({
      rawBody,
      signature: c.req.header("x-hub-signature-256") ?? null,
      eventType: c.req.header("x-github-event") ?? null,
      deliveryId: c.req.header("x-github-delivery") ?? null,
    });
    return c.json({ ok: true, deliveryId: result.deliveryId }, 202);
  });

  app.openapi(listCronSkipsRoute, async (c) => {
    const principal = requirePrincipal(c);
    const { id: projectId } = c.req.valid("param");
    const query = c.req.valid("query");
    const limit = Math.min(query.limit ? Number(query.limit) : DEFAULT_SKIPS_LIMIT, MAX_SKIPS_LIMIT);
    const { skips, nextCursor } = await deps.domain.automation.listCronSkips(
      principal,
      projectId as Id<"project">,
      query.cursor ?? null,
      limit,
    );
    return c.json({ skips: skips.map(toCronSkipResponse), nextCursor }, 200);
  });
}
