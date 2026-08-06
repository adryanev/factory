/**
 * The web half of the single web+control-plane image (spec "Packaging
 * self-host", decision 3): the control plane serves the Vite bundle it
 * ships, making web↔API skew structurally impossible — the bundle on the
 * wire is always the bundle this API was built and released with. No
 * base-URL configuration exists: the web app's API calls are same-origin
 * relative paths, and the reverse proxy terminates TLS in front of one
 * origin (`FACTORY_WEB_URL`), so there is nothing to configure or drift.
 *
 * This handler is registered in `createApp` only when the process was
 * started with `FACTORY_WEB_DIST_DIR` set (the packaged image sets it;
 * local dev does not, so `tsx src/main.ts` keeps the API-only surface and
 * `vite` serves the bundle on its own port).
 *
 * Behavior (see `registerWebStatic` for the full rule):
 *  - Only GET/HEAD with a browser Accept (`text/html`) is intercepted —
 *    everything else passes through to the routes untouched, so the API,
 *    the Runner protocol, and the webhook keep their JSON behavior.
 *  - A request whose pathname resolves to an existing file under `distDir`
 *    gets that file (content-type by extension).
 *  - Anything else gets `index.html` — the SPA reads
 *    `window.location.pathname` (see `packages/web/src/App.tsx`), so deep
 *    links like `/projects/:id/runs/:id` must reach the bundle. Those
 *    paths are also API GET routes; the Accept negotiation is what tells
 *    them apart (a browser navigation gets the SPA, the SPA's own `fetch`
 *    of the same URL gets JSON).
 *
 * Nothing here is ambient: the handler is built from an injected root
 * directory and resolves every path relative to it.
 */
import type { Context, Env, Hono } from "hono";
import { readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
};

/**
 * Resolves `pathname` inside `distDir`, returning the absolute file path —
 * or `null` when the path escapes the root or is not a regular file.
 * `..` traversal is refused by containment, not by coincidence: the image
 * serves exactly the directory it ships, and nothing outside it.
 */
export function resolveStaticFile(distDir: string, pathname: string): string | null {
  const decoded = decodeURIComponent(pathname);
  const candidate = path.normalize(path.join(distDir, decoded));
  if (!candidate.startsWith(path.resolve(distDir))) {
    return null;
  }
  if (!existsSync(candidate) || !statSync(candidate).isFile()) {
    return null;
  }
  return candidate;
}

/** True when the client prefers HTML over JSON — the browser-navigation Accept. */
export function acceptsHtml(acceptHeader: string | undefined): boolean {
  return acceptHeader?.includes("text/html") ?? false;
}

function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function indexCacheHeaders(): Record<string, string> {
  return {
    "content-type": CONTENT_TYPES[".html"] ?? "text/html; charset=utf-8",
    // index.html must never be cached: a stale bundle is the one skew the
    // single-image design cannot remove (open browser tabs), and a cached
    // index.html would make that skew persist across refreshes.
    "cache-control": "no-cache",
  };
}

/**
 * Builds the web-static handler bound to `distDir`. Returns `undefined`
 * from the handler when nothing here applies (non-GET, missing file, no
 * HTML accept), so the caller's notFound keeps its JSON shape.
 */
export function createWebStaticHandler(
  distDir: string,
  cwd: string = process.cwd(),
): (c: Context) => Promise<Response | undefined> {
  const root = path.resolve(cwd, distDir);
  return async (c) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      return undefined;
    }
    const pathname = new URL(c.req.url).pathname;

    const file = resolveStaticFile(root, pathname);
    if (file) {
      const headers = new Headers({
        "content-type": contentTypeFor(file),
        "cache-control": pathname === "/" || pathname.endsWith("/index.html") ? "no-cache" : "public, max-age=3600",
      });
      if (c.req.method === "HEAD") {
        return new Response(null, { status: 200, headers });
      }
      return new Response(await readFile(file), { headers });
    }

    if (acceptsHtml(c.req.header("accept"))) {
      const indexFile = path.join(root, "index.html");
      if (existsSync(indexFile)) {
        const headers = new Headers(indexCacheHeaders());
        if (c.req.method === "HEAD") {
          return new Response(null, { status: 200, headers });
        }
        return new Response(await readFile(indexFile), { headers });
      }
    }
    return undefined;
  };
}

/**
 * Registers the web static handler as a middleware in FRONT of the routes.
 * This is the single-image design's content negotiation: a browser
 * navigating (Accept includes `text/html`) gets the SPA — files, and
 * `index.html` for deep links like `/projects/:id/runs/:id`, whose paths
 * are ALSO API GET routes (the run detail, the pipeline-editor definition).
 * The SPA itself fetches those same paths with a fetch-style Accept, which
 * passes through to the real API route. Without this, the deep link could
 * never reach the bundle: the API route matches first.
 *
 * `/auth/*` is exempted because those are browser-navigated GETs too — the
 * OAuth callback and login redirects must reach their routes, not the SPA.
 */
export function registerWebStatic<E extends Env>(app: Hono<E>, distDir: string): void {
  const handler = createWebStaticHandler(distDir);
  app.use("*", async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      return next();
    }
    if (c.req.path.startsWith("/auth/")) {
      return next();
    }
    if (!acceptsHtml(c.req.header("accept"))) {
      return next();
    }
    const response = await handler(c);
    return response ?? next();
  });
}
