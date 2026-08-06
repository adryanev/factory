/**
 * The browser's log surface: one GET that is both live-tail and archive,
 * depending on the offset the caller asks from (spec: "Log → long-poll ≤30s
 * dari offset → daftar presigned GET; arsip memakai endpoint yang sama dari
 * offset nol"). A web-surface route like `runs.ts`: session `Principal`,
 * `camelCase` body, and no `db` reach — every read goes through
 * `deps.domain.stepRuns.readLogChunks`, which guards on the StepRun's Project
 * membership.
 *
 * The response never contains a log byte — only presigned GETs. The browser
 * fetches each chunk straight from Garage and appends it in seq order.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { errorResponseSchema, type Id } from "@factory/shared";
import type { AppEnv } from "../http-env.js";
import type { RouteDeps } from "../domain/index.js";
import { LiveTailCapacityError } from "../domain/step-run-logs.js";
import { requirePrincipal } from "./require-principal.js";

const stepRunIdParamSchema = z.object({ id: z.string().openapi({ param: { name: "id", in: "path" } }) });

const logTailQuerySchema = z.object({
  /** Which attempt's log to read; defaults to the StepRun's current attempt. */
  attempt: z.coerce.number().int().positive().optional(),
  /** Read from this seq onward. `0` is the archive read; any other value is the live-tail continuation. */
  offset: z.coerce.number().int().nonnegative().default(0),
});

const logChunkSchema = z
  .object({
    seq: z.number().int(),
    byteOffset: z.number().int().nonnegative(),
    size: z.number().int().nonnegative(),
    /** Freshly-minted 5-minute presigned GET — fetch it straight from Garage, never from this API. */
    getUrl: z.string(),
    /** The instant the presigned GET stops being valid. */
    expiresAt: z.string(),
  })
  .openapi("LogChunk");

const logTailResponseSchema = z
  .object({
    chunks: z.array(logChunkSchema),
    nextOffset: z.number().int().nonnegative(),
    attempt: z.number().int().positive(),
    ended: z.boolean(),
    waitingQuestionCount: z.number().int().nonnegative(),
  })
  .openapi("LogTailResponse");

const logTailRoute = createRoute({
  method: "get",
  path: "/step-runs/{id}/log",
  summary:
    "Live-tail and archive in one endpoint. Long-polls up to 30s from `offset` and returns any chunks with seq >= offset as a list of 5-minute presigned GETs (never bytes). Archive is the same call with offset=0. Returns immediately, empty, once the StepRun has ended. Project member.",
  request: {
    params: stepRunIdParamSchema,
    query: logTailQuerySchema,
  },
  responses: {
    200: {
      description: "Ok. `ended: true` means nothing more can arrive — stop polling. One tab = one hanging connection; no SSE, no WebSocket.",
      content: { "application/json": { schema: logTailResponseSchema } },
    },
    401: { description: "Not logged in.", content: { "application/json": { schema: errorResponseSchema } } },
    403: { description: "Not a Project member.", content: { "application/json": { schema: errorResponseSchema } } },
    404: { description: "No such step run.", content: { "application/json": { schema: errorResponseSchema } } },
    503: { description: "Too many hanging live-tail connections.", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

export function registerStepRunLogRoutes(app: OpenAPIHono<AppEnv>, deps: RouteDeps): void {
  app.openapi(logTailRoute, async (c) => {
    const principal = requirePrincipal(c);
    const { id } = c.req.valid("param");
    const { attempt, offset } = c.req.valid("query");

    try {
      const input = { offset, ...(attempt !== undefined ? { attempt } : {}) };
      const result = await deps.domain.stepRuns.readLogChunks(principal, id as Id<"steprun">, input);
      return c.json(
        {
          chunks: result.chunks.map((chunk) => ({
            seq: chunk.seq,
            byteOffset: chunk.byteOffset,
            size: chunk.size,
            getUrl: chunk.getUrl,
            expiresAt: chunk.expiresAt.toISOString(),
          })),
          nextOffset: result.nextOffset,
          attempt: result.attempt,
          ended: result.ended,
          waitingQuestionCount: result.waitingQuestionCount,
        },
        200,
      );
    } catch (error) {
      if (error instanceof LiveTailCapacityError) {
        c.header("Retry-After", "5");
        return c.json({ code: "live_tail_capacity_exceeded", message: error.message }, 503);
      }
      throw error;
    }
  });
}
