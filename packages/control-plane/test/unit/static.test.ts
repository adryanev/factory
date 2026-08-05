/**
 * Unit tests for the single-image web surface (`src/static.ts`, spec
 * "Packaging self-host", decision 3: web served by the control plane). The
 * handler is tested standalone — it is a wildcard registered after every
 * route, and its contract with the router is "return `undefined` for
 * anything that is not ours, so the JSON notFound keeps its shape".
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { acceptsHtml, createWebStaticHandler, registerWebStatic, resolveStaticFile } from "../../src/static.js";

async function withDistDir<T>(files: Record<string, string>, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "factory-web-dist-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      const full = path.join(dir, name);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, content);
    }
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("resolveStaticFile", () => {
  it("resolves files inside the dist dir", async () => {
    await withDistDir({ "index.html": "<html />", "assets/app.js": "// js" }, async (dir) => {
      expect(resolveStaticFile(dir, "/")).toBeNull(); // "/" is the directory itself, not a file
      expect(resolveStaticFile(dir, "/index.html")).toBe(path.join(dir, "index.html"));
      expect(resolveStaticFile(dir, "/assets/app.js")).toBe(path.join(dir, "assets", "app.js"));
    });
  });

  it("refuses path traversal outside the dist dir", async () => {
    await withDistDir({ "index.html": "<html />" }, async (dir) => {
      expect(resolveStaticFile(dir, "/../compose.yaml")).toBeNull();
      expect(resolveStaticFile(dir, "/..%2Fcompose.yaml")).toBeNull();
      expect(resolveStaticFile(dir, "/missing.js")).toBeNull();
    });
  });
});

describe("acceptsHtml", () => {
  it("is true for browser navigation and false for fetch-style Accepts", () => {
    expect(acceptsHtml("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")).toBe(true);
    expect(acceptsHtml("*/*")).toBe(false);
    expect(acceptsHtml("application/json")).toBe(false);
    expect(acceptsHtml(undefined)).toBe(false);
  });
});

describe("web static handler", () => {
  it("serves the SPA at / and deep-link routes when the client accepts HTML", async () => {
    await withDistDir({ "index.html": "<html>spa</html>" }, async (dir) => {
      const app = new Hono();
      app.get("*", createWebStaticHandler(dir));

      for (const target of ["/", "/projects/p1/runs/r1", "/pipeline-editor"]) {
        const response = await app.request(target, { headers: { accept: "text/html" } });
        expect(response.status, target).toBe(200);
        expect(await response.text(), target).toBe("<html>spa</html>");
        expect(response.headers.get("cache-control")).toBe("no-cache");
      }
    });
  });

  it("serves asset files with a content-type", async () => {
    await withDistDir({ "assets/app.js": "console.log(1)" }, async (dir) => {
      const app = new Hono();
      app.get("*", createWebStaticHandler(dir));

      const response = await app.request("/assets/app.js", { headers: { accept: "*/*" } });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("console.log(1)");
      expect(response.headers.get("content-type")).toContain("text/javascript");
    });
  });

  it("falls through to the router for a fetch-style miss — the API 404 keeps its JSON shape", async () => {
    await withDistDir({ "index.html": "<html>spa</html>" }, async (dir) => {
      const app = new Hono();
      app.get("*", createWebStaticHandler(dir));
      app.notFound((c) => c.json({ code: "not_found" }, 404));

      const response = await app.request("/no/such/api", { headers: { accept: "*/*" } });
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toContain("application/json");
    });
  });

  it("ignores non-GET methods", async () => {
    await withDistDir({ "index.html": "<html>spa</html>" }, async (dir) => {
      const app = new Hono();
      app.get("*", createWebStaticHandler(dir));
      app.notFound((c) => c.json({ code: "not_found" }, 404));

      const response = await app.request("/", { method: "POST" });
      expect(response.status).toBe(404);
    });
  });

  it("serves HEAD without a body", async () => {
    await withDistDir({ "assets/app.js": "console.log(1)" }, async (dir) => {
      const app = new Hono();
      app.get("*", createWebStaticHandler(dir));

      const response = await app.request("/assets/app.js", { method: "HEAD" });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("");
    });
  });
});

describe("registerWebStatic — the middleware in front of the routes", () => {
  it("gives the SPA to a browser navigation even when an API route matches the same path", async () => {
    await withDistDir({ "index.html": "<html>spa</html>" }, async (dir) => {
      const app = new Hono();
      registerWebStatic(app, dir);
      app.get("/projects/:id/runs/:runId", (c) => c.json({ run: "data" }, 200));

      const navigation = await app.request("/projects/p1/runs/r1", {
        headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
      });
      expect(navigation.status).toBe(200);
      expect(await navigation.text()).toBe("<html>spa</html>");

      const apiFetch = await app.request("/projects/p1/runs/r1", { headers: { accept: "*/*" } });
      expect(apiFetch.status).toBe(200);
      expect(apiFetch.headers.get("content-type")).toContain("application/json");
    });
  });

  it("lets /auth/* browser navigations through to their routes (OAuth callback, login redirects)", async () => {
    await withDistDir({ "index.html": "<html>spa</html>" }, async (dir) => {
      const app = new Hono();
      registerWebStatic(app, dir);
      app.get("/auth/github/callback", (c) => c.redirect("https://factory.example/", 302));
      app.get("/auth/github/login", (c) => c.redirect("https://github.com/login/oauth/authorize", 302));

      const callback = await app.request("/auth/github/callback?code=abc", {
        headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
      });
      expect(callback.status).toBe(302);
      expect(callback.headers.get("location")).toBe("https://factory.example/");

      const login = await app.request("/auth/github/login", {
        headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
      });
      expect(login.status).toBe(302);
      expect(login.headers.get("location")).toBe("https://github.com/login/oauth/authorize");
    });
  });

  it("leaves non-HTML requests untouched", async () => {
    await withDistDir({ "index.html": "<html>spa</html>" }, async (dir) => {
      const app = new Hono();
      registerWebStatic(app, dir);
      app.notFound((c) => c.json({ code: "not_found" }, 404));

      const apiMiss = await app.request("/no/such/api", { headers: { accept: "application/json" } });
      expect(apiMiss.status).toBe(404);
      expect(apiMiss.headers.get("content-type")).toContain("application/json");
    });
  });
});
