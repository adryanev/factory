/**
 * The operator/UI half of Runner management — distinct from
 * `runner-protocol.ts`'s nine Runner-authenticated endpoints. These five
 * are ordinary web <-> control-plane routes: session `Principal`, CSRF
 * header required, `camelCase` bodies, matching every other file in this
 * directory. Runner pool membership is org-wide (see `db/schema/runners.ts`
 * — no `project_id`), so the gate is org `owner`, not Project `admin`;
 * `cancelStepRun` is the one exception, gated on the StepRun's own Project
 * membership instead (see `domain/step-run-ops.ts`).
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { errorResponseSchema, type Id } from "@factory/shared";
import type { AppEnv } from "../http-env.js";
import type { RouteDeps } from "../domain/index.js";
import { requirePrincipal } from "./require-principal.js";

const runnerIdParamSchema = z.object({ id: z.string().openapi({ param: { name: "id", in: "path" } }) });
const stepRunIdParamSchema = z.object({ id: z.string().openapi({ param: { name: "id", in: "path" } }) });

const mintJoinTokenRoute = createRoute({
  method: "post",
  path: "/runner-joins",
  summary: "Mints a single-use Runner join token. Org owner only. The raw token is returned exactly once — only its hash is ever stored.",
  responses: {
    201: { description: "Minted.", content: { "application/json": { schema: z.object({ token: z.string() }) } } },
    401: { description: "Not logged in.", content: { "application/json": { schema: errorResponseSchema } } },
    403: { description: "Not an org owner.", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

const setPolicyRoute = createRoute({
  method: "post",
  path: "/runners/{id}/policy",
  summary: "Sets operator-written policy: slots and tags (spec: \"kebijakan ditulis operator\"). Org owner only.",
  request: {
    params: runnerIdParamSchema,
    body: {
      content: {
        "application/json": {
          schema: z.object({ slots: z.number().int().positive(), tags: z.array(z.string()) }),
        },
      },
    },
  },
  responses: {
    200: { description: "Set.", content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } } },
    401: { description: "Not logged in.", content: { "application/json": { schema: errorResponseSchema } } },
    403: { description: "Not an org owner.", content: { "application/json": { schema: errorResponseSchema } } },
    404: { description: "No such runner.", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

const drainRunnerRoute = createRoute({
  method: "post",
  path: "/runners/{id}/drain",
  summary: "Operator/UI write of desired_state='draining' — the same column the Runner's own /runners/me/drain writes (spec: \"ditulis CLI lokal maupun tombol UI\"). Org owner only.",
  request: { params: runnerIdParamSchema },
  responses: {
    200: { description: "Draining.", content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } } },
    401: { description: "Not logged in.", content: { "application/json": { schema: errorResponseSchema } } },
    403: { description: "Not an org owner.", content: { "application/json": { schema: errorResponseSchema } } },
    404: { description: "No such runner.", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

const revokeRunnerRoute = createRoute({
  method: "post",
  path: "/runners/{id}/revoke",
  summary: "Instant fencing, not killing (spec, verbatim): the Runner's secret stops authenticating from this point on, regardless of whether its process is still alive. Org owner only.",
  request: { params: runnerIdParamSchema },
  responses: {
    200: { description: "Revoked.", content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } } },
    401: { description: "Not logged in.", content: { "application/json": { schema: errorResponseSchema } } },
    403: { description: "Not an org owner.", content: { "application/json": { schema: errorResponseSchema } } },
    404: { description: "No such runner.", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

const cancelStepRunRoute = createRoute({
  method: "post",
  path: "/step-runs/{id}/cancel",
  summary: "Authoritative cancel: the row goes `cancelled` immediately (spec: \"Cancel otoritatif di control plane\"). A /result already in flight for this StepRun is answered 409. Project member.",
  request: { params: stepRunIdParamSchema },
  responses: {
    200: { description: "Cancelled (or already was).", content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } } },
    400: { description: "Already ended with a different outcome.", content: { "application/json": { schema: errorResponseSchema } } },
    401: { description: "Not logged in.", content: { "application/json": { schema: errorResponseSchema } } },
    403: { description: "Not a Project member.", content: { "application/json": { schema: errorResponseSchema } } },
    404: { description: "No such step run.", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

export function registerRunnerAdminRoutes(app: OpenAPIHono<AppEnv>, deps: RouteDeps): void {
  app.openapi(mintJoinTokenRoute, async (c) => {
    const principal = requirePrincipal(c);
    const { token } = await deps.domain.runners.mintJoinToken(principal);
    return c.json({ token }, 201);
  });

  app.openapi(setPolicyRoute, async (c) => {
    const principal = requirePrincipal(c);
    const { id } = c.req.valid("param");
    const { slots, tags } = c.req.valid("json");
    await deps.domain.runners.setPolicy(principal, id as Id<"runner">, { slots, tags });
    return c.json({ ok: true as const }, 200);
  });

  app.openapi(drainRunnerRoute, async (c) => {
    const principal = requirePrincipal(c);
    const { id } = c.req.valid("param");
    await deps.domain.runners.drain(principal, id as Id<"runner">);
    return c.json({ ok: true as const }, 200);
  });

  app.openapi(revokeRunnerRoute, async (c) => {
    const principal = requirePrincipal(c);
    const { id } = c.req.valid("param");
    await deps.domain.runners.revoke(principal, id as Id<"runner">);
    return c.json({ ok: true as const }, 200);
  });

  app.openapi(cancelStepRunRoute, async (c) => {
    const principal = requirePrincipal(c);
    const { id } = c.req.valid("param");
    await deps.domain.stepRuns.cancel(principal, id as Id<"steprun">);
    return c.json({ ok: true as const }, 200);
  });
}
