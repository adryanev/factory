/**
 * Seam-1 test rig (spec: "Testing Decisions" -> Seam 1). Boots a throwaway
 * Postgres container, runs the Drizzle migrations exactly as shipped, boots
 * the control plane with an injected clock and random source, and hands
 * back a base URL so tests can fire real HTTP at it. No mocks of the
 * control plane itself — a Runner-shaped test only needs to be an ordinary
 * HTTP client.
 */
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { createDatabase } from "../../src/db/client.js";
import { MIGRATIONS_FOLDER } from "../../src/db/migrations-path.js";
import { createClaimConnectionLimiter, type AppDeps, type Clock, type RandomSource } from "../../src/deps.js";
import { bootstrapBreakGlassAccount } from "../../src/domain/auth.js";
import { bootControlPlane } from "../../src/boot.js";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from "../../src/csrf.js";
import { createFakeGithubOAuthClient, type FakeGithubOAuthClient } from "./fake-github-oauth.js";
import type { GithubIdentity } from "../../src/domain/github-identity.js";
import { createFakeGitHost, type FakeGitHost } from "./fake-git-host.js";

export const BREAK_GLASS_TEST_PASSWORD = "correct horse battery staple";

export interface TestRig {
  baseUrl: string;
  pool: Pool;
  githubOAuth: FakeGithubOAuthClient;
  gitHost: FakeGitHost;
  /** Moves the injected clock. No test in this rig ever reads the wall clock. */
  setClock(date: Date): void;
  /** `fetch` with the CSRF header every mutating request needs already set — tests only add it explicitly when they mean to test its absence. */
  fetchWithCsrf(input: string, init?: RequestInit): Promise<Response>;
  /** Logs in via break-glass and returns the `Cookie` header value for subsequent requests. */
  loginAsBreakGlass(): Promise<string>;
  /** Registers a fake GitHub identity, drives the real callback endpoint, and returns the `Cookie` header value for subsequent requests. */
  loginAsGithub(identity: GithubIdentity): Promise<string>;
  stop(): Promise<void>;
}

/** Deterministic, seeded — never `crypto.getRandomValues`. Good enough for id uniqueness in tests. */
function seededRandom(seed: number): RandomSource {
  let state = seed;
  return {
    bytes: (length: number) => {
      const out = new Uint8Array(length);
      for (let i = 0; i < length; i++) {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        out[i] = state % 256;
      }
      return out;
    },
  };
}

function sessionCookieFromResponse(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) {
    throw new Error("expected a Set-Cookie header on the login response");
  }
  // Only the name=value pair belongs in a request's Cookie header — strip
  // the attributes (`Path`, `HttpOnly`, `SameSite`, ...).
  return setCookie.split(";")[0]!;
}

export interface TestRigOptions {
  /** Defaults to a small, fast range — production is 20000-30000ms (spec); tests that need to prove the herd-breakup behavior without a 20s wait inject a tiny one instead. */
  claimHoldRangeMs?: { min: number; max: number };
  /** Defaults to 2000 (spec: "Batas 2000 koneksi menggantung per instance"); the connection-cap test injects a tiny one so it doesn't need 2000 real hanging sockets. */
  maxHangingClaims?: number;
}

export async function startTestRig(options: TestRigOptions = {}): Promise<TestRig> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    "postgres:16-alpine",
  ).start();

  const pool = new Pool({ connectionString: container.getConnectionUri() });
  await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });

  let currentTime = new Date("2026-01-01T00:00:00.000Z");
  const clock: Clock = { now: () => currentTime };
  const githubOAuth = createFakeGithubOAuthClient();
  const gitHost = createFakeGitHost();

  const deps: AppDeps = {
    db: createDatabase(pool),
    pool,
    clock,
    random: seededRandom(42),
    githubOAuth,
    gitHost,
    claimHoldRangeMs: options.claimHoldRangeMs ?? { min: 150, max: 350 },
    claimLimiter: createClaimConnectionLimiter(options.maxHangingClaims ?? 2000),
  };

  await bootstrapBreakGlassAccount(deps, BREAK_GLASS_TEST_PASSWORD);

  // Sweep-before-listen, exactly the composition `main.ts` uses (see `boot.ts`).
  const { server, port } = await bootControlPlane(deps, 0);

  const baseUrl = `http://127.0.0.1:${port}`;

  const fetchWithCsrf = (input: string, init: RequestInit = {}) =>
    fetch(input, {
      ...init,
      headers: { ...init.headers, [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
    });

  return {
    baseUrl,
    pool,
    githubOAuth,
    gitHost,
    setClock: (date: Date) => {
      currentTime = date;
    },
    fetchWithCsrf,
    async loginAsBreakGlass() {
      const response = await fetchWithCsrf(`${baseUrl}/auth/breakglass/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: BREAK_GLASS_TEST_PASSWORD }),
      });
      if (!response.ok) {
        throw new Error(`break-glass login failed: ${response.status} ${await response.text()}`);
      }
      return sessionCookieFromResponse(response);
    },
    async loginAsGithub(identity: GithubIdentity) {
      const code = `fake-code-${identity.githubUserId}`;
      githubOAuth.registerCode(code, identity);
      const response = await fetch(
        `${baseUrl}/auth/github/callback?code=${encodeURIComponent(code)}`,
      );
      if (!response.ok) {
        throw new Error(`github login failed: ${response.status} ${await response.text()}`);
      }
      return sessionCookieFromResponse(response);
    },
    async stop() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await pool.end();
      await container.stop();
    },
  };
}
