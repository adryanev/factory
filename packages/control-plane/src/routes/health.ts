import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { errorResponseSchema } from "@factory/shared";
import { sql } from "drizzle-orm";
import type { AppDeps } from "../deps.js";
import type { AppEnv } from "../http-env.js";

const healthResponseSchema = z
  .object({
    status: z.literal("ok"),
    time: z.string().openapi({ example: "2026-08-03T00:00:00.000Z" }),
  })
  .openapi("HealthResponse");

const readyResponseSchema = z.object({ status: z.literal("ready") }).openapi("ReadyResponse");

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  summary: "Liveness probe. Never touches Postgres.",
  responses: {
    200: {
      description: "The process is running.",
      content: { "application/json": { schema: healthResponseSchema } },
    },
  },
});

const readyRoute = createRoute({
  method: "get",
  path: "/ready",
  summary: "Readiness probe. Confirms Postgres is reachable.",
  responses: {
    200: {
      description: "Postgres answered.",
      content: { "application/json": { schema: readyResponseSchema } },
    },
    503: {
      description: "Postgres did not answer.",
      content: { "application/json": { schema: errorResponseSchema } },
    },
  },
});

export function registerHealthRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps): void {
  app.openapi(healthRoute, (c) => {
    return c.json({ status: "ok" as const, time: deps.clock.now().toISOString() }, 200);
  });

  app.openapi(readyRoute, async (c) => {
    try {
      await deps.db.execute(sql`select 1`);
      return c.json({ status: "ready" as const }, 200);
    } catch {
      return c.json({ code: "not_ready", message: "database is not reachable" }, 503);
    }
  });
}
