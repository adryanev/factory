import { OpenAPIHono } from "@hono/zod-openapi";
import { getCookie } from "hono/cookie";
import type { AppDeps } from "./deps.js";
import { createDomain } from "./domain/index.js";
import {
  DomainValidationError,
  ForbiddenError,
  LeaseConflictError,
  NotFoundError,
  ProtocolVersionError,
  UnauthorizedError,
} from "./domain/errors.js";
import type { AppEnv } from "./http-env.js";
import { CSRF_HEADER_NAME } from "./csrf.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerScaffoldProbeRoutes } from "./routes/scaffold-probes.js";
import { registerAuthRoutes, SESSION_COOKIE_NAME } from "./routes/auth.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerGroupRoutes } from "./routes/groups.js";
import { registerRunRoutes } from "./routes/runs.js";
import { registerSecretRoutes } from "./routes/secrets.js";
import { registerRunnerProtocolRoutes } from "./routes/runner-protocol.js";
import { registerRunnerAdminRoutes } from "./routes/runner-admin.js";
import { isRunnerProtocolPath } from "./routes/runner-protocol-paths.js";

const MAX_JSON_BODY_BYTES = 1024 * 1024; // spec: "Batas ukuran: badan JSON 1 MiB semua endpoint" (Runner surface).

/**
 * Composition root for the HTTP surface. Takes the dependency object built
 * once at process boot (or once per test) and wires it into every route —
 * routes never read a global pool, clock, or random source.
 *
 * Two pieces of cross-cutting behavior live here because they are
 * transport concerns, not domain ones: resolving the session cookie into a
 * `Principal` (authentication, allowed to be ambient) and the CSRF header
 * check (spec: "CSRF ditutup SameSite=Lax + kewajiban header non-sederhana
 * ... nol token, nol tabel").
 */
export function createApp(deps: AppDeps): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({ code: "validation_error", message: result.error.message }, 400);
      }
      return undefined;
    },
  });

  const domain = createDomain(deps);

  // Authentication: resolve the session cookie into a Principal, ambiently,
  // for every request. Never used for authorization decisions itself —
  // every domain function still requires the resolved Principal to be
  // passed in explicitly by the route handler.
  app.use("*", async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE_NAME);
    const principal = token ? await domain.auth.resolveSession(token) : null;
    c.set("principal", principal);
    await next();
  });

  // CSRF: SameSite=Lax already withholds the cookie from cross-site
  // POST/PUT/PATCH/DELETE. This is the second half of the spec's chosen
  // defense — a non-"simple" header that forces the browser into a CORS
  // preflight, which a foreign origin cannot pass because this server sets
  // no permissive Access-Control-Allow-Origin. Zero tokens, zero tables.
  // Exempt: the Runner protocol surface (`routes/runner-protocol-paths.ts`)
  // — a Runner is a bearer-authenticated non-browser client with no ambient
  // cookie a foreign origin could ever ride, so this defense has nothing to
  // defend for those paths, and requiring the header there would just be
  // friction with no security value.
  app.use("*", async (c, next) => {
    const isMutating = !["GET", "HEAD", "OPTIONS"].includes(c.req.method);
    if (isMutating && !isRunnerProtocolPath(c.req.path) && c.req.header(CSRF_HEADER_NAME) === undefined) {
      return c.json(
        { code: "csrf_header_required", message: `mutating requests must send the ${CSRF_HEADER_NAME} header` },
        403,
      );
    }
    await next();
  });

  // Body-size cap for the Runner protocol surface (spec: "badan JSON 1 MiB
  // semua endpoint"). Best-effort on `Content-Length` — a Runner is inside
  // this system's trust boundary already (spec: "Runner sudah ada di dalam
  // batas kepercayaan"), so this is a defensive ceiling, not an adversarial
  // one, and a client omitting the header (chunked transfer) simply isn't
  // capped here.
  app.use("*", async (c, next) => {
    if (isRunnerProtocolPath(c.req.path)) {
      const contentLength = c.req.header("content-length");
      if (contentLength && Number(contentLength) > MAX_JSON_BODY_BYTES) {
        return c.json({ code: "payload_too_large", message: `body exceeds ${MAX_JSON_BODY_BYTES} bytes` }, 413);
      }
    }
    await next();
  });

  app.onError((error, c) => {
    if (error instanceof UnauthorizedError) {
      return c.json({ code: "unauthorized", message: error.message }, 401);
    }
    if (error instanceof ForbiddenError) {
      return c.json({ code: error.code, message: error.message }, 403);
    }
    if (error instanceof NotFoundError) {
      return c.json({ code: "not_found", message: error.message }, 404);
    }
    if (error instanceof DomainValidationError) {
      return c.json({ code: error.code, message: error.message }, 400);
    }
    if (error instanceof ProtocolVersionError) {
      return c.json({ code: "protocol_version_unsupported", message: error.message }, 426);
    }
    if (error instanceof LeaseConflictError) {
      return c.json({ code: "lease_conflict", message: error.message }, 409);
    }
    console.error("unhandled error", error);
    return c.json({ code: "internal_error", message: "unexpected error" }, 500);
  });

  app.notFound((c) => c.json({ code: "not_found", message: "route not found" }, 404));

  registerHealthRoutes(app, deps);
  registerScaffoldProbeRoutes(app, deps);
  registerAuthRoutes(app, { domain, clock: deps.clock });
  registerProjectRoutes(app, { domain, clock: deps.clock });
  registerGroupRoutes(app, { domain, clock: deps.clock });
  registerRunRoutes(app, { domain, clock: deps.clock });
  registerSecretRoutes(app, { domain, clock: deps.clock });
  registerRunnerProtocolRoutes(app, { domain, clock: deps.clock });
  registerRunnerAdminRoutes(app, { domain, clock: deps.clock });

  return app;
}
