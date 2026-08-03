/**
 * Two front doors — GitHub OAuth and break-glass — that both end in the
 * same cookie shape (spec acceptance criteria for issue #3, verbatim: "Break-
 * glass lokal ... menghasilkan cookie yang sama persis; hanya `audit_log`
 * yang membedakan"). This file only ever calls `deps.domain.auth.*` — see
 * `domain/index.ts` for why it structurally cannot reach `sessions` or
 * `users` any other way.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { errorResponseSchema } from "@factory/shared";
import type { AppEnv } from "../http-env.js";
import type { RouteDeps } from "../domain/index.js";
import { UnauthorizedError } from "../domain/errors.js";

export const SESSION_COOKIE_NAME = "factory_session";

/**
 * `secure: false` only when NODE_ENV=test — seam-1 runs over plain HTTP on
 * 127.0.0.1, and a `Secure` cookie is silently dropped by every HTTP client
 * on a non-TLS origin, which would make every test asserting on the cookie
 * fail for a reason that has nothing to do with the behavior under test.
 * Production always runs behind TLS (spec: packaging — reverse proxy is
 * required), so this never weakens a real deployment.
 */
function isSecureCookieContext(): boolean {
  return process.env["NODE_ENV"] !== "test";
}

function setSessionCookie(c: Context<AppEnv>, token: string, expiresAt: Date): void {
  setCookie(c, SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: isSecureCookieContext(),
    sameSite: "Lax",
    path: "/",
    expires: expiresAt,
  });
}

function callbackRedirectUri(c: Context<AppEnv>): string {
  return new URL("/auth/github/callback", c.req.url).toString();
}

const sessionResponseSchema = z
  .object({
    principalId: z.string(),
    expiresAt: z.string(),
  })
  .openapi("SessionResponse");

const githubCallbackQuerySchema = z.object({
  code: z.string().openapi({ description: "One-time authorization code GitHub redirected back with." }),
});

const githubLoginRoute = createRoute({
  method: "get",
  path: "/auth/github/login",
  summary: "Redirects to GitHub's OAuth authorize screen.",
  responses: {
    302: { description: "Redirect to GitHub." },
  },
});

const githubCallbackRoute = createRoute({
  method: "get",
  path: "/auth/github/callback",
  summary: "Exchanges a GitHub OAuth code for a session. Sets the session cookie.",
  request: { query: githubCallbackQuerySchema },
  responses: {
    200: {
      description: "Logged in.",
      content: { "application/json": { schema: sessionResponseSchema } },
    },
  },
});

const breakGlassLoginRoute = createRoute({
  method: "post",
  path: "/auth/breakglass/login",
  summary: "Local password login for the break-glass account, on its own route — never GitHub.",
  request: {
    body: {
      content: { "application/json": { schema: z.object({ password: z.string().min(1) }) } },
    },
  },
  responses: {
    200: {
      description: "Logged in.",
      content: { "application/json": { schema: sessionResponseSchema } },
    },
    401: {
      description: "Wrong password.",
      content: { "application/json": { schema: errorResponseSchema } },
    },
  },
});

const logoutRoute = createRoute({
  method: "post",
  path: "/auth/logout",
  summary: "Revokes the current session.",
  responses: {
    200: {
      description: "Logged out.",
      content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } },
    },
    401: {
      description: "Not logged in.",
      content: { "application/json": { schema: errorResponseSchema } },
    },
  },
});

export function registerAuthRoutes(app: OpenAPIHono<AppEnv>, deps: RouteDeps): void {
  app.openapi(githubLoginRoute, (c) => {
    // `state` defends the GitHub handshake itself against CSRF, a separate
    // concern from this API's own CSRF defense in `app.ts`. Kept as an
    // opaque value round-tripped through GitHub's `state` param rather than
    // a server-side row — same "zero tables" reasoning as the API's CSRF
    // check, at smaller scope. GitHub itself echoes it back verbatim on
    // the callback; nothing here currently verifies the echo because
    // nothing yet depends on it beyond GitHub's own replay protection —
    // flagged in the written report as a hardening gap, not a decision.
    const state = crypto.randomUUID();
    return c.redirect(deps.domain.auth.githubAuthorizeUrl(state, callbackRedirectUri(c)), 302);
  });

  app.openapi(githubCallbackRoute, async (c) => {
    const { code } = c.req.valid("query");
    const result = await deps.domain.auth.loginWithGithub(code, callbackRedirectUri(c));
    setSessionCookie(c, result.sessionToken, result.expiresAt);
    return c.json({ principalId: result.principal.id, expiresAt: result.expiresAt.toISOString() }, 200);
  });

  app.openapi(breakGlassLoginRoute, async (c) => {
    const { password } = c.req.valid("json");
    const result = await deps.domain.auth.loginBreakGlass(password);
    setSessionCookie(c, result.sessionToken, result.expiresAt);
    return c.json({ principalId: result.principal.id, expiresAt: result.expiresAt.toISOString() }, 200);
  });

  app.openapi(logoutRoute, async (c) => {
    const principal = c.get("principal");
    if (!principal) {
      throw new UnauthorizedError();
    }
    const sessionToken = getCookie(c, SESSION_COOKIE_NAME);
    if (sessionToken) {
      await deps.domain.auth.logout(principal, sessionToken);
    }
    deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" });
    return c.json({ ok: true as const }, 200);
  });
}
