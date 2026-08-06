/**
 * Seam-1 test rig (spec: "Testing Decisions" -> Seam 1). Boots a throwaway
 * Postgres container, runs the Drizzle migrations exactly as shipped, boots
 * the control plane with an injected clock and random source, and hands
 * back a base URL so tests can fire real HTTP at it. No mocks of the
 * control plane itself — a Runner-shaped test only needs to be an ordinary
 * HTTP client.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { startPostgresContainer } from "../postgres-container.js";
import { createTestPool } from "../postgres-container.js";
import { createDatabase } from "../../src/db/client.js";
import { MIGRATIONS_FOLDER } from "../../src/db/migrations-path.js";
import {
  createClaimConnectionLimiter,
  type AppDeps,
  type Clock,
  type NotificationSender,
  type RandomSource,
} from "../../src/deps.js";
import { createFileKeyRing } from "../../src/domain/master-key.js";
import { bootstrapBreakGlassAccount } from "../../src/domain/auth.js";
import { bootControlPlane } from "../../src/boot.js";
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from "../../src/csrf.js";
import { createFakeGithubOAuthClient, type FakeGithubOAuthClient } from "./fake-github-oauth.js";
import type { GithubIdentity } from "../../src/domain/github-identity.js";
import { createFakeGitHost, type FakeGitHost } from "./fake-git-host.js";
import { createFakeObjectStore, type FakeObjectStore } from "./fake-object-store.js";

export const BREAK_GLASS_TEST_PASSWORD = "correct horse battery staple";

export interface TestRig {
  baseUrl: string;
  pool: Pool;
  githubOAuth: FakeGithubOAuthClient;
  gitHost: FakeGitHost;
  objectStore: FakeObjectStore;
  notifications: { sent: { url: string; text: string }[] };
  /**
   * The composition-root deps object, exposed so tests can drive the
   * control-plane executor directly (`runControlPlaneStepCycle`) instead of
   * racing a background loop against the rig's shared database.
   */
  deps: AppDeps;
  /**
   * Absolute path of this rig's master key file — the key material comes
   * from a FILE, never an env var (spec), and the rig exercises exactly that
   * path. Rotation tests rewrite this file (adding a key version) and call
   * the rotate endpoint to observe the incremental re-encryption.
   */
  masterKeyFile: string;
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
  /** Defaults to 2000 (spec: "Satu tab browser = satu koneksi menggantung"); the live-tail cap test injects a tiny one. */
  maxHangingLiveTails?: number;
  /** Defaults to 30000 (spec: "long-poll ≤30s dari offset"); live-tail tests inject a tiny hold so the empty-hold behavior is provable without a 30s test. */
  liveTailHoldMs?: number;
}

export async function startTestRig(options: TestRigOptions = {}): Promise<TestRig> {
  const container: StartedPostgreSqlContainer = await startPostgresContainer();

  const pool = createTestPool(container.getConnectionUri());
  await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });

  let currentTime = new Date("2026-01-01T00:00:00.000Z");
  const clock: Clock = { now: () => currentTime };
  const githubOAuth = createFakeGithubOAuthClient();
  const gitHost = createFakeGitHost();
  const objectStore = createFakeObjectStore(() => currentTime);
  const notifications = { sent: [] as { url: string; text: string }[] };
  const notificationSender: NotificationSender = {
    async send(url, payload) {
      notifications.sent.push({ url, text: payload.text });
    },
  };

  // Master key from a FILE — exactly the production shape (spec). One stable
  // version 1 key; rotation tests rewrite this file to add version 2.
  const masterKeyDir = await mkdtemp(path.join(os.tmpdir(), "factory-master-key-"));
  const masterKeyFile = path.join(masterKeyDir, "master-key.json");
  const v1Key = "1a".repeat(32);
  await writeFile(masterKeyFile, JSON.stringify({ currentVersion: 1, keys: { "1": v1Key } }));

  const deps: AppDeps = {
    db: createDatabase(pool),
    pool,
    clock,
    random: seededRandom(42),
    githubOAuth,
    gitHost,
    notificationSender,
    keyring: createFileKeyRing(masterKeyFile),
    objectStore,
    githubWebhookSecret: "test-webhook-secret",
    automationScheduleWatermark: { minute: null },
    claimHoldRangeMs: options.claimHoldRangeMs ?? { min: 150, max: 350 },
    claimLimiter: createClaimConnectionLimiter(options.maxHangingClaims ?? 2000),
    liveTailHoldMs: options.liveTailHoldMs ?? 400,
    liveTailLimiter: createClaimConnectionLimiter(options.maxHangingLiveTails ?? 2000),
    // The control-plane lessee and the Run-page URL a Commit Status links to
    // (issue #17) — a stable identity per rig, and a base URL the assertions
    // can compare `target_url` against.
    controlPlaneInstanceId: "control-plane-test",
    runPageBaseUrl: "https://factory.test",
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
    objectStore,
    notifications,
    deps,
    masterKeyFile,
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
      await rm(masterKeyDir, { recursive: true, force: true });
    },
  };
}
