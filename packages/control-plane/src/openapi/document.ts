import { Pool } from "pg";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { createApp } from "../app.js";
import { createDeps } from "../deps.js";
import type { KeyRing } from "../domain/master-key.js";

export const OPENAPI_CONFIG = {
  openapi: "3.0.3",
  info: {
    title: "Factory Control Plane API",
    version: "0.0.0",
    description:
      "REST surface: web <-> control plane. Domain terms follow CONTEXT.md; the full contract is in .scratch/distributed-software-factory/spec.md.",
  },
} as const;

/**
 * Builds the OpenAPI document from the same Zod route definitions the
 * server registers. Route registration only records metadata — no handler
 * ever runs — so this pool never actually connects and the keyring is never
 * read (the throwaway below would explode on first use, which is the point:
 * document generation must never touch key material).
 */
export function buildOpenApiDocument(): ReturnType<OpenAPIHono["getOpenAPIDocument"]> {
  const pool = new Pool({ connectionString: "postgres://unused/unused" });
  const unusedKeyring: KeyRing = {
    currentVersion: () => {
      throw new Error("document generation must never read the master key");
    },
    key: () => {
      throw new Error("document generation must never read the master key");
    },
  };
  // Route registration only records metadata — no handler ever runs — so a
  // placeholder client id/secret never actually reaches github.com.
  const app = createApp(createDeps(pool, { clientId: "unused", clientSecret: "unused" }, undefined, unusedKeyring));
  return app.getOpenAPIDocument(OPENAPI_CONFIG);
}
