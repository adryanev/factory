import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppDeps } from "./deps.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerScaffoldProbeRoutes } from "./routes/scaffold-probes.js";

/**
 * Composition root for the HTTP surface. Takes the dependency object built
 * once at process boot (or once per test) and wires it into every route —
 * routes never read a global pool, clock, or random source.
 */
export function createApp(deps: AppDeps): OpenAPIHono {
  const app = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({ code: "validation_error", message: result.error.message }, 400);
      }
      return undefined;
    },
  });

  app.onError((error, c) => {
    console.error("unhandled error", error);
    return c.json({ code: "internal_error", message: "unexpected error" }, 500);
  });

  app.notFound((c) => c.json({ code: "not_found", message: "route not found" }, 404));

  registerHealthRoutes(app, deps);
  registerScaffoldProbeRoutes(app, deps);

  return app;
}
