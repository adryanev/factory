/**
 * Admin surface for credentials: ServiceAccounts, Project secrets (write-only
 * — no endpoint in this file ever returns a stored value), and the per-Project
 * egress allowlist. Every handler follows the house rule: resolve the caller
 * with `requirePrincipal`, hand it to exactly one `deps.domain` function, and
 * shape the reply. No handler reaches `db` (see `domain/index.ts`).
 *
 * The secret write paths deliberately name their bodies `value` (not
 * `secret`): the OpenAPI document and the audit log both end up carrying the
 * *word* but never the value, and keeping the field name honest makes that
 * boundary greppable.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { errorResponseSchema, isValidId, type Id } from "@factory/shared";
import type { AppEnv } from "../http-env.js";
import type { RouteDeps } from "../domain/index.js";
import { requirePrincipal } from "./require-principal.js";

const projectIdParamSchema = z.object({ id: z.string().openapi({ param: { name: "id", in: "path" } }) });

const serviceAccountSchema = z
  .object({ id: z.string(), projectId: z.string(), name: z.string() })
  .openapi("ServiceAccount");

const storedSecretSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    ownerPrincipalId: z.string(),
    name: z.string(),
    keyVersion: z.number().int(),
  })
  .openapi("StoredSecret");

const createServiceAccountRoute = createRoute({
  method: "post",
  path: "/projects/{id}/service-accounts",
  summary:
    "Creates a ServiceAccount for a Project — the Principal that owns the Project's secrets (spec: \"kunci Project menempel ke ServiceAccount, bukan ke Project\"). Project admin only.",
  request: {
    params: projectIdParamSchema,
    body: {
      content: { "application/json": { schema: z.object({ name: z.string().min(1) }) } },
    },
  },
  responses: {
    201: { description: "Created.", content: { "application/json": { schema: serviceAccountSchema } } },
    401: { description: "Not logged in.", content: { "application/json": { schema: errorResponseSchema } } },
    403: { description: "Not a Project admin.", content: { "application/json": { schema: errorResponseSchema } } },
    404: { description: "No such Project.", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

const listServiceAccountsRoute = createRoute({
  method: "get",
  path: "/projects/{id}/service-accounts",
  summary: "Lists a Project's ServiceAccounts. Project member (names are not credentials).",
  request: { params: projectIdParamSchema },
  responses: {
    200: {
      description: "Ok.",
      content: { "application/json": { schema: z.array(serviceAccountSchema) } },
    },
    401: { description: "Not logged in.", content: { "application/json": { schema: errorResponseSchema } } },
    403: { description: "Not a Project member.", content: { "application/json": { schema: errorResponseSchema } } },
    404: { description: "No such Project.", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

const storeSecretRoute = createRoute({
  method: "post",
  path: "/projects/{id}/secrets",
  summary:
    "Stores (or re-stores) a Project secret, encrypted at rest under the current master key version. Write-only: the value is never returned and never decryptable through this surface. Project admin only.",
  request: {
    params: projectIdParamSchema,
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              id: z.string().refine((id) => isValidId("secret", id), { message: "must be a valid secret_ id" }),
              name: z.string().min(1),
              value: z.string().min(6, "secret values must be at least 6 bytes"),
              serviceAccountId: z.string(),
            })
            .openapi("StoreSecretRequest"),
        },
      },
    },
  },
  responses: {
    201: { description: "Stored (metadata only).", content: { "application/json": { schema: storedSecretSchema } } },
    401: { description: "Not logged in.", content: { "application/json": { schema: errorResponseSchema } } },
    403: { description: "Not a Project admin.", content: { "application/json": { schema: errorResponseSchema } } },
    404: { description: "No such Project.", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

const updateSecretRoute = createRoute({
  method: "patch",
  path: "/projects/{id}/secrets",
  summary:
    "Replaces a secret's value, re-encrypted under the current master key version. Write-only, like store. Project admin only. The secret id travels in the body, never the URL (spec: \"tidak ada credential di path maupun query string\").",
  request: {
    params: projectIdParamSchema,
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              secretId: z.string(),
              value: z.string().min(6, "secret values must be at least 6 bytes"),
            })
            .openapi("UpdateSecretRequest"),
        },
      },
    },
  },
  responses: {
    200: { description: "Updated (metadata only).", content: { "application/json": { schema: storedSecretSchema } } },
    401: { description: "Not logged in.", content: { "application/json": { schema: errorResponseSchema } } },
    403: { description: "Not a Project admin.", content: { "application/json": { schema: errorResponseSchema } } },
    404: { description: "No such secret or Project.", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

const deleteSecretRoute = createRoute({
  method: "delete",
  path: "/projects/{id}/secrets",
  summary:
    "Deletes a secret. Project admin only, audited. The secret id travels in the body, never the URL.",
  request: {
    params: projectIdParamSchema,
    body: {
      content: {
        "application/json": {
          schema: z.object({ secretId: z.string() }).openapi("DeleteSecretRequest"),
        },
      },
    },
  },
  responses: {
    200: { description: "Deleted.", content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } } },
    401: { description: "Not logged in.", content: { "application/json": { schema: errorResponseSchema } } },
    403: { description: "Not a Project admin.", content: { "application/json": { schema: errorResponseSchema } } },
    404: { description: "No such secret or Project.", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

const listSecretsRoute = createRoute({
  method: "get",
  path: "/projects/{id}/secrets",
  summary:
    "Lists a Project's secrets — names and key versions only, never values. The value surface is write-only by design (AC: \"secrets are NOT readable back by anyone\").",
  request: { params: projectIdParamSchema },
  responses: {
    200: {
      description: "Ok (metadata only).",
      content: { "application/json": { schema: z.array(storedSecretSchema) } },
    },
    401: { description: "Not logged in.", content: { "application/json": { schema: errorResponseSchema } } },
    403: { description: "Not a Project member.", content: { "application/json": { schema: errorResponseSchema } } },
    404: { description: "No such Project.", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

const rotateSecretsRoute = createRoute({
  method: "post",
  path: "/projects/{id}/secrets/rotate",
  summary:
    "Re-encrypts every secret of the Project under the current master key version. Incremental and interruptible: rows not yet rewritten still decrypt (their old version stays in the key file), and running Runs are never disturbed. Project admin only, audited.",
  request: { params: projectIdParamSchema },
  responses: {
    200: {
      description: "Rotated.",
      content: {
        "application/json": {
          schema: z.object({ rotated: z.number().int(), toVersion: z.number().int() }),
        },
      },
    },
    401: { description: "Not logged in.", content: { "application/json": { schema: errorResponseSchema } } },
    403: { description: "Not a Project admin.", content: { "application/json": { schema: errorResponseSchema } } },
    404: { description: "No such Project.", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

const setEgressAllowlistRoute = createRoute({
  method: "put",
  path: "/projects/{id}/egress-allowlist",
  summary:
    "Replaces the Project's egress allowlist wholesale — the only egress the sandbox is allowed, everything else is denied. Every change is recorded in the audit log (AC: \"allowlist per Project masuk daftar audit\"). Project admin only.",
  request: {
    params: projectIdParamSchema,
    body: {
      content: {
        "application/json": { schema: z.object({ allowlist: z.array(z.string().min(1)) }) },
      },
    },
  },
  responses: {
    200: {
      description: "Set.",
      content: { "application/json": { schema: z.object({ allowlist: z.array(z.string()) }) } },
    },
    401: { description: "Not logged in.", content: { "application/json": { schema: errorResponseSchema } } },
    403: { description: "Not a Project admin.", content: { "application/json": { schema: errorResponseSchema } } },
    404: { description: "No such Project.", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

export function registerSecretRoutes(app: OpenAPIHono<AppEnv>, deps: RouteDeps): void {
  app.openapi(createServiceAccountRoute, async (c) => {
    const principal = requirePrincipal(c);
    const { id } = c.req.valid("param");
    const { name } = c.req.valid("json");
    const account = await deps.domain.secrets.createServiceAccount(principal, id as Id<"project">, name);
    return c.json(account, 201);
  });

  app.openapi(listServiceAccountsRoute, async (c) => {
    const principal = requirePrincipal(c);
    const { id } = c.req.valid("param");
    const accounts = await deps.domain.secrets.listServiceAccounts(principal, id as Id<"project">);
    return c.json(accounts, 200);
  });

  app.openapi(storeSecretRoute, async (c) => {
    const principal = requirePrincipal(c);
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const stored = await deps.domain.secrets.store(principal, id as Id<"project">, {
      id: body.id as Id<"secret">,
      name: body.name,
      value: body.value,
      ownerPrincipalId: body.serviceAccountId as Id<"serviceaccount">,
    });
    return c.json(stored, 201);
  });

  app.openapi(updateSecretRoute, async (c) => {
    const principal = requirePrincipal(c);
    const { id } = c.req.valid("param");
    const { secretId, value } = c.req.valid("json");
    const stored = await deps.domain.secrets.update(principal, id as Id<"project">, secretId as Id<"secret">, value);
    return c.json(stored, 200);
  });

  app.openapi(deleteSecretRoute, async (c) => {
    const principal = requirePrincipal(c);
    const { id } = c.req.valid("param");
    const { secretId } = c.req.valid("json");
    await deps.domain.secrets.remove(principal, id as Id<"project">, secretId as Id<"secret">);
    return c.json({ ok: true as const }, 200);
  });

  app.openapi(listSecretsRoute, async (c) => {
    const principal = requirePrincipal(c);
    const { id } = c.req.valid("param");
    const secretsList = await deps.domain.secrets.list(principal, id as Id<"project">);
    return c.json(secretsList, 200);
  });

  app.openapi(rotateSecretsRoute, async (c) => {
    const principal = requirePrincipal(c);
    const { id } = c.req.valid("param");
    const result = await deps.domain.secrets.rotate(principal, id as Id<"project">);
    return c.json(result, 200);
  });

  app.openapi(setEgressAllowlistRoute, async (c) => {
    const principal = requirePrincipal(c);
    const { id } = c.req.valid("param");
    const { allowlist } = c.req.valid("json");
    const set = await deps.domain.egress.setAllowlist(principal, id as Id<"project">, allowlist);
    return c.json({ allowlist: set }, 200);
  });
}
