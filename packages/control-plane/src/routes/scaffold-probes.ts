/**
 * Not a product endpoint. This exists solely to exercise the seam-1 rig
 * end to end: a client-generated id, a Zod-validated body, a real write and
 * a real read against Postgres through Drizzle. See `db/schema.ts` for why
 * `scaffold_probes` isn't one of the spec's domain tables.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { errorResponseSchema, isValidId } from "@factory/shared";
import { eq } from "drizzle-orm";
import { scaffoldProbes, scaffoldProbeStatuses } from "../db/schema.js";
import type { AppDeps } from "../deps.js";
import type { AppEnv } from "../http-env.js";

const scaffoldProbeSchema = z
  .object({
    id: z.string(),
    status: z.enum(scaffoldProbeStatuses),
    message: z.string(),
    createdAt: z.string(),
  })
  .openapi("ScaffoldProbe");

const createScaffoldProbeSchema = z
  .object({
    id: z.string().openapi({ description: "Client-generated id with the `probe` prefix." }),
    message: z.string().min(1).max(500),
  })
  .openapi("CreateScaffoldProbeRequest");

const paramsSchema = z.object({
  id: z.string().openapi({ param: { name: "id", in: "path" } }),
});

const createProbeRoute = createRoute({
  method: "post",
  path: "/scaffold-probes",
  summary: "Writes one row to Postgres using a client-generated id.",
  request: {
    body: { content: { "application/json": { schema: createScaffoldProbeSchema } } },
  },
  responses: {
    201: {
      description: "Row written.",
      content: { "application/json": { schema: scaffoldProbeSchema } },
    },
    400: {
      description: "Malformed id.",
      content: { "application/json": { schema: errorResponseSchema } },
    },
  },
});

const getProbeRoute = createRoute({
  method: "get",
  path: "/scaffold-probes/{id}",
  summary: "Reads one row back from Postgres.",
  request: { params: paramsSchema },
  responses: {
    200: {
      description: "Row found.",
      content: { "application/json": { schema: scaffoldProbeSchema } },
    },
    404: {
      description: "No such row.",
      content: { "application/json": { schema: errorResponseSchema } },
    },
  },
});

function toResponse(row: typeof scaffoldProbes.$inferSelect) {
  return {
    id: row.id,
    status: row.status as (typeof scaffoldProbeStatuses)[number],
    message: row.message,
    createdAt: row.createdAt.toISOString(),
  };
}

export function registerScaffoldProbeRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps): void {
  app.openapi(createProbeRoute, async (c) => {
    const body = c.req.valid("json");
    if (!isValidId("probe", body.id)) {
      return c.json({ code: "invalid_id", message: "id must be a valid probe_ id" }, 400);
    }
    const [row] = await deps.db
      .insert(scaffoldProbes)
      .values({ id: body.id, message: body.message })
      .returning();
    return c.json(toResponse(row!), 201);
  });

  app.openapi(getProbeRoute, async (c) => {
    const { id } = c.req.valid("param");
    const [row] = await deps.db.select().from(scaffoldProbes).where(eq(scaffoldProbes.id, id));
    if (!row) {
      return c.json({ code: "not_found", message: `no scaffold probe with id ${id}` }, 404);
    }
    return c.json(toResponse(row), 200);
  });
}
