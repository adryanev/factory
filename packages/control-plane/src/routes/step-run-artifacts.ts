/**
 * The browser's artifact surface (issue #10): list a StepRun's artifacts and
 * fetch one — metadata plus a freshly-minted presigned GET, never bytes. A
 * web-surface route like `step-run-logs.ts`: session `Principal`, `camelCase`
 * body, and no `db` reach — every read goes through `deps.domain.stepRuns`
 * which guards on Project membership (AC9: org `owner` is not automatically
 * a member).
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { ARTIFACT_KINDS, errorResponseSchema, type Id } from "@factory/shared";
import type { AppEnv } from "../http-env.js";
import type { RouteDeps } from "../domain/index.js";
import { requirePrincipal } from "./require-principal.js";

const artifactMetaSchema = z
  .object({
    id: z.string(),
    key: z.string(),
    kind: z.enum(ARTIFACT_KINDS),
    contentType: z.string(),
    sizeBytes: z.number().int().nonnegative(),
    createdAt: z.string(),
  })
  .openapi("Artifact");

const artifactReadSchema = artifactMetaSchema
  .extend({
    /** Freshly-minted 5-minute presigned GET — fetch the bytes straight from Garage, never from this API. */
    getUrl: z.string(),
    /** The instant the presigned GET stops being valid. */
    expiresAt: z.string(),
  })
  .openapi("ArtifactRead");

const stepRunIdParamSchema = z.object({ id: z.string().openapi({ param: { name: "id", in: "path" } }) });
const artifactIdParamSchema = z.object({ id: z.string().openapi({ param: { name: "id", in: "path" } }) });

const listArtifactsRoute = createRoute({
  method: "get",
  path: "/step-runs/{id}/artifacts",
  summary:
    "Lists one StepRun's artifacts — metadata only, no bytes. The optional `key` filter is the per-key history query (spec: 'riwayat adalah kueri per key diurutkan menurut turn'): each turn is its own StepRun, so walking turns with ?key=prd yields the history. Project member.",
  request: {
    params: stepRunIdParamSchema,
    query: z.object({ key: z.string().optional() }),
  },
  responses: {
    200: {
      description: "Ok.",
      content: { "application/json": { schema: z.object({ artifacts: z.array(artifactMetaSchema) }) } },
    },
    401: { description: "Not logged in.", content: { "application/json": { schema: errorResponseSchema } } },
    403: { description: "Not a Project member.", content: { "application/json": { schema: errorResponseSchema } } },
    404: { description: "No such step run.", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

const getArtifactRoute = createRoute({
  method: "get",
  path: "/artifacts/{id}",
  summary:
    "One artifact: metadata plus a 5-minute presigned GET, minted only after the Project-membership check. The browser fetches the bytes straight from Garage. Project member.",
  request: { params: artifactIdParamSchema },
  responses: {
    200: {
      description: "Ok.",
      content: { "application/json": { schema: artifactReadSchema } },
    },
    401: { description: "Not logged in.", content: { "application/json": { schema: errorResponseSchema } } },
    403: { description: "Not a Project member.", content: { "application/json": { schema: errorResponseSchema } } },
    404: { description: "No such artifact.", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

export function registerStepRunArtifactRoutes(app: OpenAPIHono<AppEnv>, deps: RouteDeps): void {
  app.openapi(listArtifactsRoute, async (c) => {
    const principal = requirePrincipal(c);
    const { id } = c.req.valid("param");
    const { key } = c.req.valid("query");
    const artifacts = await deps.domain.stepRuns.listArtifacts(principal, id as Id<"steprun">, key);
    return c.json(
      {
        artifacts: artifacts.map((artifact) => ({
          id: artifact.id,
          key: artifact.key,
          kind: artifact.kind,
          contentType: artifact.contentType,
          sizeBytes: artifact.sizeBytes,
          createdAt: artifact.createdAt.toISOString(),
        })),
      },
      200,
    );
  });

  app.openapi(getArtifactRoute, async (c) => {
    const principal = requirePrincipal(c);
    const { id } = c.req.valid("param");
    const artifact = await deps.domain.stepRuns.getArtifact(principal, id as Id<"artifact">);
    return c.json(
      {
        id: artifact.id,
        key: artifact.key,
        kind: artifact.kind,
        contentType: artifact.contentType,
        sizeBytes: artifact.sizeBytes,
        createdAt: artifact.createdAt.toISOString(),
        getUrl: artifact.getUrl,
        expiresAt: artifact.expiresAt.toISOString(),
      },
      200,
    );
  });
}
