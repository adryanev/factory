/**
 * Every handler below does exactly one thing before it does anything else:
 * resolve the caller with `requirePrincipal` and hand it to a `deps.domain`
 * function as the first argument. No handler here ever reads
 * `project_members` or `projects` itself — it cannot, `RouteDeps` carries
 * no `db` (see `domain/index.ts`).
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { errorResponseSchema, type Id } from "@factory/shared";
import type { AppEnv } from "../http-env.js";
import type { RouteDeps } from "../domain/index.js";
import { requirePrincipal } from "./require-principal.js";

const projectSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    automationEnabled: z.boolean(),
    allowSharedAgentCredential: z.boolean(),
    hostExecAllowed: z.boolean(),
    egressAllowlist: z.array(z.string()),
    /** A configured flag is safe to expose; the incoming-webhook URL is a bearer secret. */
    notificationWebhookConfigured: z.boolean(),
  })
  .openapi("Project");

const idParamSchema = z.object({ id: z.string().openapi({ param: { name: "id", in: "path" } }) });

const listProjectsRoute = createRoute({
  method: "get",
  path: "/projects",
  summary: "Projects the caller is a member of. Never a list of every Project (spec: \"tidak bisa melihat apa pun di luar itu\").",
  responses: {
    200: { description: "Ok.", content: { "application/json": { schema: z.array(projectSchema) } } },
    401: { description: "Not logged in.", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

const createProjectRoute = createRoute({
  method: "post",
  path: "/projects",
  summary: "Creates a Project. Org `owner` only.",
  request: {
    body: { content: { "application/json": { schema: z.object({ name: z.string().min(1) }) } } },
  },
  responses: {
    201: { description: "Created.", content: { "application/json": { schema: projectSchema } } },
    401: { description: "Not logged in.", content: { "application/json": { schema: errorResponseSchema } } },
    403: { description: "Not an org owner.", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

const getProjectRoute = createRoute({
  method: "get",
  path: "/projects/{id}",
  summary: "One Project. 403 (not a member) beats 404 for an id that does exist; 404 only for an id that genuinely doesn't.",
  request: { params: idParamSchema },
  responses: {
    200: { description: "Ok.", content: { "application/json": { schema: projectSchema } } },
    401: { description: "Not logged in.", content: { "application/json": { schema: errorResponseSchema } } },
    403: {
      description: "Not a member. Body names the Project and the reason; an org owner's body also names the self-add escape hatch.",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    404: { description: "No such Project.", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

const addMemberRoute = createRoute({
  method: "post",
  path: "/projects/{id}/members",
  summary: "Adds (or changes the role of) a Project member. Project `admin` only.",
  request: {
    params: idParamSchema,
    body: {
      content: {
        "application/json": {
          schema: z.object({ principalId: z.string(), role: z.enum(["admin", "member"]) }),
        },
      },
    },
  },
  responses: {
    200: { description: "Added.", content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } } },
    401: { description: "Not logged in.", content: { "application/json": { schema: errorResponseSchema } } },
    403: { description: "Not a Project admin.", content: { "application/json": { schema: errorResponseSchema } } },
    404: { description: "No such Project.", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

const selfAddRoute = createRoute({
  method: "post",
  path: "/projects/{id}/members/self",
  summary:
    "The org owner escape hatch this issue's acceptance criteria name: an owner denied a Project adds themselves as admin. Always audited.",
  request: { params: idParamSchema },
  responses: {
    200: { description: "Added.", content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } } },
    401: { description: "Not logged in.", content: { "application/json": { schema: errorResponseSchema } } },
    403: { description: "Not an org owner.", content: { "application/json": { schema: errorResponseSchema } } },
    404: { description: "No such Project.", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

const updateProjectSettingsRoute = createRoute({
  method: "patch",
  path: "/projects/{id}",
  summary:
    "Admin settings write. Configures the User→ServiceAccount fallback or the one Project notification channel webhook. The webhook URL is never returned.",
  request: {
    params: idParamSchema,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            allowSharedAgentCredential: z.boolean().optional(),
            notificationWebhookUrl: z.string().url().max(2048).nullable().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Updated.", content: { "application/json": { schema: projectSchema } } },
    401: { description: "Not logged in.", content: { "application/json": { schema: errorResponseSchema } } },
    403: { description: "Not a Project admin.", content: { "application/json": { schema: errorResponseSchema } } },
    404: { description: "No such Project.", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

function toProjectResponse(project: {
  id: string;
  name: string;
  automationEnabled: boolean;
  allowSharedAgentCredential: boolean;
  hostExecAllowed: boolean;
  egressAllowlist: string[];
  notificationWebhookUrl: string | null;
}) {
  return {
    id: project.id,
    name: project.name,
    automationEnabled: project.automationEnabled,
    allowSharedAgentCredential: project.allowSharedAgentCredential,
    hostExecAllowed: project.hostExecAllowed,
    egressAllowlist: project.egressAllowlist,
    notificationWebhookConfigured: project.notificationWebhookUrl !== null,
  };
}

export function registerProjectRoutes(app: OpenAPIHono<AppEnv>, deps: RouteDeps): void {
  app.openapi(listProjectsRoute, async (c) => {
    const principal = requirePrincipal(c);
    const projectsList = await deps.domain.projects.listMine(principal);
    return c.json(projectsList.map(toProjectResponse), 200);
  });

  app.openapi(createProjectRoute, async (c) => {
    const principal = requirePrincipal(c);
    const { name } = c.req.valid("json");
    const project = await deps.domain.projects.create(principal, name);
    return c.json(toProjectResponse(project), 201);
  });

  app.openapi(getProjectRoute, async (c) => {
    const principal = requirePrincipal(c);
    const { id } = c.req.valid("param");
    const project = await deps.domain.projects.get(principal, id as Id<"project">);
    return c.json(toProjectResponse(project), 200);
  });

  app.openapi(addMemberRoute, async (c) => {
    const principal = requirePrincipal(c);
    const { id } = c.req.valid("param");
    const { principalId, role } = c.req.valid("json");
    await deps.domain.projects.addMember(principal, id as Id<"project">, principalId as Id<"user">, role);
    return c.json({ ok: true as const }, 200);
  });

  app.openapi(selfAddRoute, async (c) => {
    const principal = requirePrincipal(c);
    const { id } = c.req.valid("param");
    await deps.domain.projects.selfAddAsMember(principal, id as Id<"project">);
    return c.json({ ok: true as const }, 200);
  });

  app.openapi(updateProjectSettingsRoute, async (c) => {
    const principal = requirePrincipal(c);
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const project = await deps.domain.projects.updateSettings(principal, id as Id<"project">, {
      ...(body.allowSharedAgentCredential !== undefined
        ? { allowSharedAgentCredential: body.allowSharedAgentCredential }
        : {}),
      ...(body.notificationWebhookUrl !== undefined
        ? { notificationWebhookUrl: body.notificationWebhookUrl }
        : {}),
    });
    return c.json(toProjectResponse(project), 200);
  });
}
