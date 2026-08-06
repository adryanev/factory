import { z } from "zod";

/**
 * The one error body shape used across every REST surface (web <-> control
 * plane, control plane <-> Runner). `code` is for logs and programmatic
 * branching; `message` is for humans. Nothing else goes in this envelope.
 *
 * Plain Zod on purpose — `shared` knows nothing about OpenAPI or Hono.
 * Callers that need this registered as a named OpenAPI component tag it
 * with `.openapi(...)` themselves at the route-definition layer.
 */
export const errorResponseSchema = z.object({
  code: z.string(),
  message: z.string(),
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;
