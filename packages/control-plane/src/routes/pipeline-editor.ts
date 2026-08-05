/**
 * The visual Pipeline editor's web surface (issue #20). Two routes, both
 * `member`-level: the host-repo candidates the editor may lock onto, and the
 * one write — open a PR with the serialized Pipeline YAML in the host repo.
 * No draft mode exists: the repository stays the source of truth, the PR is
 * the only output, and the editor PR is not an audit event (see
 * `domain/pipeline-editor.ts`).
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { errorResponseSchema, type Id } from "@factory/shared";
import type { AppEnv } from "../http-env.js";
import type { RouteDeps } from "../domain/index.js";
import { requirePrincipal } from "./require-principal.js";

const projectIdParamSchema = z.object({ id: z.string().openapi({ param: { name: "id", in: "path" } }) });

const editorRepositorySchema = z
  .object({
    id: z.string(),
    owner: z.string(),
    name: z.string(),
    defaultBranch: z.string(),
  })
  .openapi("EditorRepository");

const editorPullRequestSchema = z
  .object({
    prNumber: z.number().int(),
    prUrl: z.string(),
    headBranch: z.string(),
    commitSha: z.string(),
  })
  .openapi("EditorPullRequest");

const listRepositoriesRoute = createRoute({
  method: "get",
  path: "/projects/{id}/repositories",
  summary:
    "The host-repo candidates the Pipeline editor may lock onto (issue #20, AC1: UI scope is this Project's repositories, nothing else). Project `member`.",
  request: { params: projectIdParamSchema },
  responses: {
    200: {
      description: "Ok.",
      content: { "application/json": { schema: z.object({ repositories: z.array(editorRepositorySchema) }) } },
    },
    401: { description: "Not logged in.", content: { "application/json": { schema: errorResponseSchema } } },
    403: { description: "Not a Project member.", content: { "application/json": { schema: errorResponseSchema } } },
    404: { description: "No such Project.", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

const openEditorPullRequestRoute = createRoute({
  method: "post",
  path: "/projects/{id}/pipeline-editor",
  summary:
    "Validates the serialized Pipeline definition with the shared Zod schema and opens a PR containing the YAML in the host repository (issue #20). Project `member`; the PR is attributed to the clicking user via users.noreply.github.com with factory[bot] as committer. No draft mode, not an audit event.",
  request: {
    params: projectIdParamSchema,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            repositoryId: z.string().min(1).openapi({ description: "The host repository of this Project." }),
            pipelinePath: z
              .string()
              .min(1)
              .openapi({ description: "The file the YAML is written to, e.g. .factory/pipeline.yaml." }),
            yaml: z.string().min(1).openapi({ description: "The serialized Pipeline definition." }),
            editId: z
              .string()
              .min(1)
              .openapi({
                description:
                  "Client-generated idempotency key (branch-safe, lowercase); rides in the branch name so a retried request adopts the same PR.",
              }),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "PR opened.",
      content: { "application/json": { schema: editorPullRequestSchema } },
    },
    400: {
      description: "Definition invalid or identity not attributable (break-glass).",
      content: { "application/json": { schema: errorResponseSchema } },
    },
    401: { description: "Not logged in.", content: { "application/json": { schema: errorResponseSchema } } },
    403: { description: "Not a Project member.", content: { "application/json": { schema: errorResponseSchema } } },
    404: { description: "No such Project or repository.", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

export function registerPipelineEditorRoutes(app: OpenAPIHono<AppEnv>, deps: RouteDeps): void {
  app.openapi(listRepositoriesRoute, async (c) => {
    const principal = requirePrincipal(c);
    const { id } = c.req.valid("param");
    const repositories = await deps.domain.editor.listRepositories(principal, id as Id<"project">);
    return c.json({ repositories }, 200);
  });

  app.openapi(openEditorPullRequestRoute, async (c) => {
    const principal = requirePrincipal(c);
    const { id } = c.req.valid("param");
    const { repositoryId, pipelinePath, yaml, editId } = c.req.valid("json");
    const pr = await deps.domain.editor.openPullRequest(principal, id as Id<"project">, {
      repositoryId: repositoryId as Id<"repository">,
      pipelinePath,
      yaml,
      editId,
    });
    return c.json(pr, 201);
  });
}
