import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { errorResponseSchema, type Id } from "@factory/shared";
import type { AppEnv } from "../http-env.js";
import type { RouteDeps } from "../domain/index.js";
import { requirePrincipal } from "./require-principal.js";

const groupSchema = z.object({ id: z.string(), projectId: z.string(), name: z.string() }).openapi("Group");

const projectIdParamSchema = z.object({ id: z.string().openapi({ param: { name: "id", in: "path" } }) });
const groupIdParamSchema = z.object({ id: z.string().openapi({ param: { name: "id", in: "path" } }) });

const createGroupRoute = createRoute({
  method: "post",
  path: "/projects/{id}/groups",
  summary: "Creates a Group. Any Project member.",
  request: {
    params: projectIdParamSchema,
    body: { content: { "application/json": { schema: z.object({ name: z.string().min(1) }) } } },
  },
  responses: {
    201: { description: "Created.", content: { "application/json": { schema: groupSchema } } },
    401: { description: "Not logged in.", content: { "application/json": { schema: errorResponseSchema } } },
    403: { description: "Not a Project member.", content: { "application/json": { schema: errorResponseSchema } } },
    404: { description: "No such Project.", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

const addGroupMemberRoute = createRoute({
  method: "post",
  path: "/groups/{id}/members",
  summary:
    "Adds a Group member. Domain-layer invariant, not UI: the target must already be a member of the Group's Project.",
  request: {
    params: groupIdParamSchema,
    body: { content: { "application/json": { schema: z.object({ principalId: z.string() }) } } },
  },
  responses: {
    200: { description: "Added.", content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } } },
    400: {
      description: "Target is not a member of the Group's Project.",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    401: { description: "Not logged in.", content: { "application/json": { schema: errorResponseSchema } } },
    403: { description: "Not a Project member.", content: { "application/json": { schema: errorResponseSchema } } },
    404: { description: "No such Group.", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

export function registerGroupRoutes(app: OpenAPIHono<AppEnv>, deps: RouteDeps): void {
  app.openapi(createGroupRoute, async (c) => {
    const principal = requirePrincipal(c);
    const { id } = c.req.valid("param");
    const { name } = c.req.valid("json");
    const group = await deps.domain.groups.create(principal, id as Id<"project">, name);
    return c.json(group, 201);
  });

  app.openapi(addGroupMemberRoute, async (c) => {
    const principal = requirePrincipal(c);
    const { id } = c.req.valid("param");
    const { principalId } = c.req.valid("json");
    await deps.domain.groups.addMember(principal, id as Id<"group">, principalId as Id<"user">);
    return c.json({ ok: true as const }, 200);
  });
}
