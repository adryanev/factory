/**
 * The `exec:docker` egress enforcer (issue #22): a tiny forward proxy that
 * runs **inside a sidecar container** on the StepRun's docker networks and is
 * the ONLY path off the isolated per-StepRun network (the network is created
 * with `--internal`, so the step container cannot reach anything outside it).
 *
 * The proxy is implemented at the raw socket layer (`node:net`), forwarding
 * request bytes verbatim rather than speaking node's HTTP server protocol.
 * That matters: half-closed clients — busybox wget does `shutdown(SHUT_WR)`
 * to a proxy after sending an HTTPS request — get their responses destroyed
 * by node's HTTP server ("client req end → response closed"), so only raw
 * byte relay is correct for every client. It also keeps the proxy free of
 * TLS MITM: CONNECT tunnels pass TLS bytes through untouched, and
 * absolute-form requests are forwarded as-is (TLS-wrapped only when the
 * request itself targets an `https://` URL, which no TLS session exists to
 * MITM).
 *
 * The two forward-proxy request shapes tools actually use:
 *
 *  - `CONNECT host:port` (HTTPS and generic TCP tunnels) — the proxy opens a
 *    raw TCP connection to the allowlisted host and pipes bytes both ways.
 *  - absolute-form HTTP (`GET http://host/path` or `GET https://host/path`) —
 *    the proxy connects to the destination (plain TCP, or TLS when the
 *    request URL is `https:`) and relays the request and response verbatim.
 *
 * Every destination is checked against the Project's egress allowlist with
 * the same semantics as `renderEgressRules` in `egress.ts` (pf's hostname
 * tables): an entry matches exactly (`github.com` matches only
 * `github.com`) or as a `*.` wildcard over subdomains (`*.github.com`
 * matches `api.github.com` but not the apex), case-insensitively and
 * ignoring a trailing dot. An empty allowlist denies everything.
 *
 * The proxy is shipped as a hidden `egress-proxy` subcommand of the runner
 * binary (`main.ts`): the sidecar container mounts the runner's own entry
 * directory read-only and runs `node main.js egress-proxy …`. That keeps
 * the enforcement code a normal, typechecked module of this package — unit
 * tested here with real sockets, and proven end-to-end in
 * `docker-egress.integration.test.ts`.
 */
import { createServer, connect as tcpConnect, type Server, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { parseArgs } from "node:util";

/**
 * The port the sidecar proxy listens on inside its container (the step
 * container's proxy env points at `http://<sidecar>:<port>`).
 *
 * Deliberately **80**, not an unprivileged port: busybox wget (the wget in
 * every Alpine-based sandbox image) hardcodes the proxy port to the URL
 * scheme's default — its `parse_url` never extracts `:port` from the proxy
 * env — and for HTTPS it speaks absolute-form `GET https://host/…` to the
 * proxy instead of CONNECT. Port 80 makes the proxy usable by that client
 * class; the sidecar container runs as root, so binding is not an issue.
 * CONNECT-tunneling clients (curl, git, agents) work on any port.
 */
export const EGRESS_PROXY_PORT = 80;

/**
 * Normalizes a host for allowlist comparison: lowercase, IPv6 brackets
 * stripped, trailing dot removed (`example.com.` is the same host as
 * `example.com`).
 */
export function normalizeHost(host: string): string {
  let normalized = host.trim().toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    normalized = normalized.slice(1, -1);
  }
  return normalized.replace(/\.$/, "");
}

/**
 * The allowlist check, with pf-table semantics (`egress.ts`): exact match
 * for a plain entry, subdomain-only match for a `*.` wildcard entry. A host
 * with no matching entry is denied.
 */
export function matchAllowlist(allowlist: readonly string[], host: string): boolean {
  const normalized = normalizeHost(host);
  return allowlist.some((entry) => {
    const normalizedEntry = normalizeHost(entry);
    if (normalizedEntry.startsWith("*.")) {
      const suffix = normalizedEntry.slice(1);
      return normalized.endsWith(suffix) && normalized.length > suffix.length;
    }
    return normalized === normalizedEntry;
  });
}

/** `example.com:443` → `{ host: "example.com", port: 443 }` — CONNECT's authority form, IPv6-bracket aware. */
export function parseConnectTarget(authority: string): { host: string; port: number } | null {
  if (authority.startsWith("[")) {
    const closing = authority.indexOf("]");
    if (closing === -1) return null;
    const port = Number(authority.slice(closing + 2));
    return Number.isInteger(port) ? { host: authority.slice(1, closing), port } : null;
  }
  const colon = authority.lastIndexOf(":");
  if (colon === -1) return null;
  const host = authority.slice(0, colon);
  const port = Number(authority.slice(colon + 1));
  return host.length > 0 && Number.isInteger(port) ? { host, port } : null;
}

const STATUS_DENIED = "HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\n";
const STATUS_OK = "HTTP/1.1 200 Connection Established\r\n\r\n";

/** The parsed request head of a proxy connection: the first line plus the raw head bytes to relay. */
interface ProxyRequest {
  /** The raw head (request line + headers + CRLF CRLF), relayed verbatim to the upstream. */
  head: Buffer;
  /** Absolute-form URL for plain requests, `null` for CONNECT. */
  target: URL | null;
  /** CONNECT's authority form, `null` for plain requests. */
  authority: { host: string; port: number } | null;
}

/**
 * Splits the buffered head off a proxy connection. Returns `null` until a
 * full `\r\n\r\n`-terminated head has arrived, so partial TCP segments are
 * handled without any buffering state beyond this one call.
 */
export function parseProxyHead(buffer: Buffer): { request: ProxyRequest; rest: Buffer } | null {
  const headerEnd = buffer.indexOf("\r\n\r\n");
  if (headerEnd === -1) return null;
  const head = buffer.subarray(0, headerEnd + 4);
  const rest = buffer.subarray(headerEnd + 4);
  const requestLine = head.subarray(0, headerEnd).toString("latin1").split("\r\n")[0] ?? "";
  const [method, target] = requestLine.split(" ");
  if (method === "CONNECT") {
    const authority = parseConnectTarget(target ?? "");
    return { request: { head, target: null, authority }, rest };
  }
  try {
    return { request: { head, target: new URL(target ?? ""), authority: null }, rest };
  } catch {
    return { request: { head, target: null, authority: null }, rest };
  }
}

function endWithStatus(socket: Socket, status: string): void {
  socket.end(status);
}

/**
 * The enforcement server: raw-socket forward proxy — CONNECT tunneling plus
 * absolute-form HTTP(S) relay, every destination checked against
 * `allowlist`. Listens on 0.0.0.0 — inside the sidecar container that
 * address is reachable only from the two per-StepRun networks it joins, and
 * the step container's only route off its internal network is this proxy.
 */
export function createEgressProxyServer(options: { allowlist: readonly string[] }): Server {
  // allowHalfOpen: a client that half-closes after sending its request (busybox
  // wget's `shutdown(SHUT_WR)` for HTTPS targets) must still be able to
  // receive the response; with the default `allowHalfOpen: false` the FIN
  // destroys the socket the moment it arrives.
  const server = createServer({ allowHalfOpen: true }, (clientSocket) => {
    let buffer = Buffer.alloc(0);
    let relayStarted = false;

    clientSocket.on("data", (chunk) => {
      if (relayStarted) return;
      buffer = Buffer.concat([buffer, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
      const parsed = parseProxyHead(buffer);
      if (parsed === null) return;
      relayStarted = true;
      const { request, rest } = parsed;

      if (request.authority !== null) {
        // CONNECT: tunnel the rest of the bytes (e.g. the TLS ClientHello)
        // once the tunnel is established; deny with 403 when not allowed.
        const { host, port } = request.authority;
        if (!matchAllowlist(options.allowlist, host)) {
          endWithStatus(clientSocket, STATUS_DENIED);
          return;
        }
        const upstream = tcpConnect({ host, port });
        upstream.on("connect", () => {
          clientSocket.write(STATUS_OK);
          if (rest.length > 0) upstream.write(rest);
          upstream.pipe(clientSocket);
          clientSocket.pipe(upstream);
        });
        upstream.on("error", () => clientSocket.destroy());
        clientSocket.on("error", () => upstream.destroy());
        return;
      }

      if (request.target === null) {
        endWithStatus(clientSocket, "HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n");
        return;
      }
      const { target } = request;
      if (!matchAllowlist(options.allowlist, target.hostname)) {
        endWithStatus(
          clientSocket,
          STATUS_DENIED + `factory egress proxy: ${target.hostname} is not in the project egress allowlist\n`,
        );
        return;
      }

      const port = target.port !== "" ? Number(target.port) : target.protocol === "https:" ? 443 : 80;
      const connectTo = tcpConnect({ host: target.hostname, port });
      const upstream =
        target.protocol === "https:"
          ? tlsConnect({ socket: connectTo, servername: target.hostname, rejectUnauthorized: true })
          : connectTo;
      upstream.on("connect", () => {
        // Verbatim relay: the client's own head (headers included, e.g. its
        // `Connection: close`) goes through untouched, and the upstream's
        // bytes stream back. No parsing, no rewrites. The client's half-close
        // (FIN) is deliberately NOT propagated upstream — real upstreams
        // (cloudflare et al.) abort a connection whose request side closes
        // early — while the client itself must keep receiving the response,
        // which is why the server runs with allowHalfOpen.
        upstream.write(request.head);
        if (rest.length > 0) upstream.write(rest);
        upstream.pipe(clientSocket);
        clientSocket.on("data", (d) => upstream.write(d));
        clientSocket.on("close", () => upstream.destroy());
      });
      upstream.on("error", () => {
        clientSocket.end("HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n");
      });
      clientSocket.on("error", () => upstream.destroy());
    });
  });
  return server;
}

/**
 * The `egress-proxy` subcommand entry (`main.ts`), running inside the
 * sidecar container: `node main.js egress-proxy --port 80 --allowlist
 * '["example.com"]'`. Serves until SIGTERM — which is exactly how docker
 * `stop` and the Runner's cancel path end it.
 */
export async function runEgressProxy(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: "string", default: String(EGRESS_PROXY_PORT) },
      allowlist: { type: "string" },
    },
    strict: false,
  });
  const port = Number(String(values.port ?? EGRESS_PROXY_PORT));
  const allowlist: string[] =
    values.allowlist === undefined || typeof values.allowlist === "boolean"
      ? []
      : (JSON.parse(values.allowlist) as unknown[]).map(String);

  const server = createEgressProxyServer({ allowlist });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => resolve());
  });
  console.log(`factory egress proxy listening on 0.0.0.0:${port} (${allowlist.length} allowlist entries)`);

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      server.close(() => resolve());
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  });
  return 0;
}
