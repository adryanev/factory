/**
 * The `exec:docker` egress enforcer (issue #22) — the allowlist semantics and
 * the proxy behavior, proven with real sockets but no docker and no internet:
 * the proxy's upstream is a local http/net server in the same process, and
 * "denied" is asserted as an HTTP 403 / closed tunnel. The same code is
 * proven inside a real container in `docker-egress.integration.test.ts`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { connect, type Socket } from "node:net";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createEgressProxyServer, matchAllowlist, normalizeHost, parseConnectTarget } from "../egress-proxy.js";

const servers: { close: (cb?: () => void) => void }[] = [];
const sockets: Socket[] = [];

function trackServer<T extends { close: (cb?: () => void) => void }>(server: T): T {
  servers.push(server);
  return server;
}

function trackSocket(socket: Socket): Socket {
  sockets.push(socket);
  return socket;
}

afterEach(async () => {
  sockets.splice(0).forEach((s) => s.destroy());
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

function freePort(server: { address(): AddressInfo | string | null }): number {
  return (server.address() as AddressInfo).port;
}

async function listen(server: HttpServer | NetServer): Promise<void> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
}

describe("egress proxy: allowlist semantics (pf-table parity with egress.ts)", () => {
  it("an exact entry matches that host only", () => {
    expect(matchAllowlist(["github.com"], "github.com")).toBe(true);
    expect(matchAllowlist(["github.com"], "api.github.com")).toBe(false);
    expect(matchAllowlist(["github.com"], "github.com.evil.example")).toBe(false);
  });

  it("a `*.` wildcard matches subdomains only, never the apex", () => {
    expect(matchAllowlist(["*.github.com"], "api.github.com")).toBe(true);
    expect(matchAllowlist(["*.github.com"], "a.b.github.com")).toBe(true);
    expect(matchAllowlist(["*.github.com"], "github.com")).toBe(false);
    expect(matchAllowlist(["*.github.com"], "github.com.evil.example")).toBe(false);
  });

  it("matching is case-insensitive and ignores a trailing dot", () => {
    expect(matchAllowlist(["Example.COM"], "example.com.")).toBe(true);
    expect(matchAllowlist(["*.GITHUB.com"], "API.Github.Com")).toBe(true);
  });

  it("an IP literal matches exactly", () => {
    expect(matchAllowlist(["192.168.1.10"], "192.168.1.10")).toBe(true);
    expect(matchAllowlist(["192.168.1.10"], "192.168.1.11")).toBe(false);
  });

  it("an empty allowlist denies everything — the same default-deny as renderEgressRules", () => {
    expect(matchAllowlist([], "github.com")).toBe(false);
    expect(matchAllowlist([], "127.0.0.1")).toBe(false);
  });
});

describe("egress proxy: request parsing", () => {
  it("parses CONNECT authority targets, including IPv6 brackets", () => {
    expect(parseConnectTarget("example.com:443")).toEqual({ host: "example.com", port: 443 });
    expect(parseConnectTarget("[::1]:443")).toEqual({ host: "::1", port: 443 });
    expect(parseConnectTarget("nonsense")).toBeNull();
    expect(parseConnectTarget("host:notaport")).toBeNull();
  });

  it("normalizes hosts the way the allowlist comparison needs", () => {
    expect(normalizeHost("[::1]")).toBe("::1");
    expect(normalizeHost("Example.COM.")).toBe("example.com");
  });
});

describe("egress proxy: allow/deny over real sockets", () => {
  it("forwards an absolute-form HTTP request to an allowlisted host", async () => {
    const upstream = trackServer(createHttpServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`upstream saw ${req.url}`);
    }));
    await listen(upstream);
    const port = freePort(upstream);

    const proxy = trackServer(createEgressProxyServer({ allowlist: ["127.0.0.1"] }));
    await listen(proxy);
    const proxyPort = freePort(proxy);

    const response = await new Promise<string>((resolve, reject) => {
      const socket = trackSocket(connect(proxyPort, "127.0.0.1"));
      socket.on("error", reject);
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk.toString();
        if (data.includes("\r\n\r\n") && data.includes("upstream saw")) {
          socket.destroy();
          resolve(data);
        }
      });
      socket.write(
        `GET http://127.0.0.1:${port}/hello HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
      );
      setTimeout(() => reject(new Error("proxy did not forward in time")), 5000).unref();
    });

    expect(response).toMatch(/^HTTP\/1\.1 200/);
    // The request is relayed verbatim — the upstream sees the absolute-form
    // request line exactly as the client sent it.
    expect(response).toContain("upstream saw http://127.0.0.1:");
    expect(response).toContain("/hello");
    expect(response).toContain("content-type: text/plain");
  });

  it("tunnels CONNECT to an allowlisted host", async () => {
    const echo = trackServer(createNetServer((socket) => socket.pipe(socket)));
    await listen(echo);
    const echoPort = freePort(echo);

    const proxy = trackServer(createEgressProxyServer({ allowlist: ["127.0.0.1"] }));
    await listen(proxy);
    const proxyPort = freePort(proxy);

    const echoed = await new Promise<string>((resolve, reject) => {
      const socket = trackSocket(connect(proxyPort, "127.0.0.1"));
      socket.on("error", reject);
      socket.on("data", (chunk) => {
        const text = chunk.toString();
        if (text.startsWith("HTTP/1.1 200 Connection Established")) {
          socket.write("ping-through-tunnel\n");
        } else {
          socket.destroy();
          resolve(text.trim());
        }
      });
      socket.write(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`);
      setTimeout(() => reject(new Error("CONNECT tunnel did not establish in time")), 5000).unref();
    });

    expect(echoed).toBe("ping-through-tunnel");
  });

  it("denies an absolute-form request to a host outside the allowlist with 403", async () => {
    const proxy = trackServer(createEgressProxyServer({ allowlist: ["other.example"] }));
    await listen(proxy);
    const proxyPort = freePort(proxy);

    const status = await new Promise<number>((resolve, reject) => {
      const socket = trackSocket(connect(proxyPort, "127.0.0.1"));
      socket.on("error", reject);
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk.toString();
        if (data.includes("\r\n\r\n")) {
          socket.destroy();
          resolve(Number(data.split(" ")[1]));
        }
      });
      socket.write("GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n");
      setTimeout(() => reject(new Error("proxy did not answer in time")), 5000).unref();
    });

    expect(status).toBe(403);
  });

  it("denies a CONNECT tunnel to a host outside the allowlist", async () => {
    const proxy = trackServer(createEgressProxyServer({ allowlist: ["other.example"] }));
    await listen(proxy);
    const proxyPort = freePort(proxy);

    const status = await new Promise<number>((resolve, reject) => {
      const socket = trackSocket(connect(proxyPort, "127.0.0.1"));
      socket.on("error", reject);
      socket.on("data", (chunk) => {
        socket.destroy();
        resolve(Number(chunk.toString().split(" ")[1]));
      });
      socket.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com\r\n\r\n");
      setTimeout(() => reject(new Error("proxy did not answer in time")), 5000).unref();
    });

    expect(status).toBe(403);
  });

  it("an empty allowlist denies everything through the proxy too", async () => {
    const upstream = trackServer(createHttpServer((_req, res) => res.end("leak")));
    await listen(upstream);
    const port = freePort(upstream);

    const proxy = trackServer(createEgressProxyServer({ allowlist: [] }));
    await listen(proxy);
    const proxyPort = freePort(proxy);

    const status = await new Promise<number>((resolve, reject) => {
      const socket = trackSocket(connect(proxyPort, "127.0.0.1"));
      socket.on("error", reject);
      socket.on("data", (chunk) => {
        socket.destroy();
        resolve(Number(chunk.toString().split(" ")[1]));
      });
      socket.write(`GET http://127.0.0.1:${port}/ HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`);
      setTimeout(() => reject(new Error("proxy did not answer in time")), 5000).unref();
    });

    expect(status).toBe(403);
  });
});
