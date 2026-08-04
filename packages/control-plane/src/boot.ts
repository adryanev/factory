/**
 * The one seam that guarantees ordering the acceptance criteria names
 * explicitly: the lease-expiry sweep runs to completion *before* the HTTP
 * listener opens (spec: "Sweep dijalankan sebelum listener dibuka saat
 * startup"). `main.ts` (the real process) and `test/seam1/setup.ts` (every
 * seam-1 test) both call this instead of open-coding
 * `sweep(); createApp(); serve();` themselves, so the ordering can't drift
 * between the two call sites.
 */
import { serve, type ServerType } from "@hono/node-server";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { createApp } from "./app.js";
import type { AppDeps } from "./deps.js";
import type { AppEnv } from "./http-env.js";
import { sweepExpiredLeases } from "./domain/step-run-ops.js";

export interface BootResult {
  app: OpenAPIHono<AppEnv>;
  server: ServerType;
  port: number;
}

export async function bootControlPlane(deps: AppDeps, requestedPort: number): Promise<BootResult> {
  await sweepExpiredLeases(deps);

  const app = createApp(deps);
  const { server, port } = await new Promise<{ server: ServerType; port: number }>((resolve) => {
    const started = serve({ fetch: app.fetch, port: requestedPort }, (info) => {
      resolve({ server: started, port: info.port });
    });
  });

  return { app, server, port };
}
