/**
 * Composition-root dependency object. Every access to the clock or to
 * randomness goes through this — nothing in `src/` reads `Date.now()`,
 * `Math.random()`, or `crypto.getRandomValues()` directly, so a test can
 * swap in a fixed clock or a seeded random source and get a deterministic
 * run. This is a plain object, not a DI container: one composition root
 * (`main.ts` for the real process, each seam-1 test for its own instance)
 * builds it once and passes it to `createApp`.
 *
 * Outbound network calls (GitHub App, webhooks) have no caller yet beyond
 * `githubOAuth` below, added by issue #3 — the pattern it establishes: add a
 * field here, inject it, never read `fetch`/`http` ambiently from inside a
 * handler.
 */
import type { Pool } from "pg";
import { createDatabase, type Database } from "./db/client.js";
import { createGithubOAuthClient, type GithubOAuthClient } from "./domain/github-identity.js";
import { createGithubHost, type GithubAppConfig, type GitHost } from "./domain/git-host.js";
import type { KeyRing } from "./domain/master-key.js";
import { createS3ObjectStore, type ObjectStore, type S3ObjectStoreConfig } from "./object-store.js";
import { LIVE_TAIL_HOLD_MS } from "./domain/step-run-logs.js";

export interface Clock {
  now(): Date;
}

export interface RandomSource {
  bytes(length: number): Uint8Array;
}

/** The only outbound notification seam. Implementations must not log the URL. */
export interface NotificationSender {
  send(url: string, payload: { text: string }): Promise<void>;
}

/** One hanging `/claim` long-poll connection slot. `createApp` builds exactly one of these per process (see `app.ts`) so the 2000-connection cap (spec: "Batas 2000 koneksi menggantung per instance") is real per-instance state, not a per-request illusion. */
export interface ClaimConnectionLimiter {
  tryAcquire(): boolean;
  release(): void;
}

export function createClaimConnectionLimiter(maxHangingConnections: number): ClaimConnectionLimiter {
  let hanging = 0;
  return {
    tryAcquire(): boolean {
      if (hanging >= maxHangingConnections) {
        return false;
      }
      hanging += 1;
      return true;
    },
    release(): void {
      hanging -= 1;
    },
  };
}

export interface AppDeps {
  db: Database;
  /**
   * The shared secret the GitHub App webhook signs with (issue #18). One
   * endpoint, one secret — the HMAC check in `domain/automation.ts` is the
   * only consumer; a wrong or absent secret means every webhook is rejected
   * before its payload is trusted.
   */
  githubWebhookSecret: string;
  /**
   * Mutable per-process watermark for the schedule sweep (issue #18): one
   * `on: schedule` evaluation per UTC minute per instance. Lives on deps so
   * each test rig carries its own (the fixed test clock would otherwise
   * freeze every rig behind the first one to sweep). Same shape as the
   * `claimLimiter` precedent — deps is the composition root, and this is
   * per-process state, not a route's business.
   */
  automationScheduleWatermark: { minute: string | null };
  /**
   * The raw `pg.Pool` `db` wraps. Exists for exactly one caller:
   * `domain/step-run-claim.ts`'s hand-written `claim_step_run.sql`, which
   * needs positional `$1..$5` parameter binding and `FOR UPDATE SKIP LOCKED`
   * that Drizzle's query builder cannot express (see that file's header, and
   * `test/sql/claim-step-run.test.ts`, which calls the same pool directly).
   * No other domain function should reach for this — reach for `db` instead.
   */
  pool: Pool;
  clock: Clock;
  random: RandomSource;
  githubOAuth: GithubOAuthClient;
  gitHost: GitHost;
  notificationSender: NotificationSender;
  /**
   * The master key, loaded from a FILE at boot (spec: "Master key dari file,
   * bukan environment variable") — see `domain/master-key.ts` for why the
   * key material must never ride an env var. Decrypting a secret row is the
   * one use; every decryption goes through `domain/secrets.ts`, never a
   * route.
   */
  keyring: KeyRing;
  /**
   * `/claim`'s long-poll hold duration is randomized server-side in this
   * range so a herd of Runners arriving together (e.g. right after a
   * control-plane restart) breaks up within one cycle instead of
   * thundering back all at once (spec: "durasi tahan diacak server di
   * rentang 20-30 detik"). Production always gets 20000-30000; tests inject
   * a much smaller range so the herd-breakup behavior is provable without a
   * 20-second test.
   */
  claimHoldRangeMs: { min: number; max: number };
  claimLimiter: ClaimConnectionLimiter;
  /**
   * Live-tail's long-poll hold (spec: "Log → long-poll ≤30s dari offset").
   * Production always gets 30000; tests inject a tiny value so the
   * empty-hold and connection-cap behaviors are provable without a 30-second
   * test.
   */
  liveTailHoldMs: number;
  /**
   * The lessee identity this control-plane instance claims `kind:
   * pull-request` StepRuns with (issue #17, AC1). Polymorphic with runner ids
   * in `step_runs.leased_by` — the shared `claim_step_run.sql` takes it as
   * `$1` — so two control-plane instances never execute the same
   * control-plane StepRun, exactly like two Runners never claim the same
   * row. Regenerated at boot; no two live instances share it.
   */
  controlPlaneInstanceId: string;
  /**
   * The web surface's base URL — the Commit Status `target_url`, so a PR's
   * checks area links back to this Run's page (issue #17, AC7: "Status ke
   * commit lewat Commit Status API dengan details_url ke halaman Run").
   */
  runPageBaseUrl: string;
  /** Mints presigned URLs — the control plane's half of "byte tidak pernah lewat control plane" (spec: "Artifact dan blob", "Log"). PUTs go to the Runner (uploads, log chunks), GETs go to the browser (live-tail, archive, artifacts). The control plane never proxies a byte. */
  objectStore: ObjectStore;
  /**
   * The browser-side analogue of `claimLimiter`: one live-tail tab is one
   * hanging connection (spec: "Satu tab browser = satu koneksi menggantung"),
   * and this caps how many can hang per instance.
   */
  liveTailLimiter: ClaimConnectionLimiter;
}

export function createSystemClock(): Clock {
  return { now: () => new Date() };
}

export function createSystemRandom(): RandomSource {
  return {
    bytes: (length: number) => {
      const bytes = new Uint8Array(length);
      crypto.getRandomValues(bytes);
      return bytes;
    },
  };
}

export interface GithubOAuthConfig {
  clientId: string;
  clientSecret: string;
}

/**
 * Process-scoped runtime configuration the control plane needs beyond
 * infrastructure credentials — the lessee identity it executes control-plane
 * Steps under, and the base URL it links a Run's page back to. Both are
 * per-deployment facts, so they ride the composition root like everything
 * else rather than being read ambiently by a handler.
 */
export interface ControlPlaneRuntimeConfig {
  controlPlaneInstanceId: string;
  runPageBaseUrl: string;
}

const PRODUCTION_CLAIM_HOLD_RANGE_MS = { min: 20_000, max: 30_000 };
const MAX_HANGING_CLAIM_CONNECTIONS = 2000;
const MAX_HANGING_LIVE_TAIL_CONNECTIONS = 2000;

/**
 * Builds real (non-test) deps around an already-connected pool. `githubConfig`,
 * `gitHostConfig`, and `objectStoreConfig` come from the environment in
 * `main.ts` — infra config, not the clock/random/network seams this file
 * otherwise documents as injected. `gitHostConfig` carries the GitHub App
 * credentials (`GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY`) that let the control
 * plane mint installation tokens at `/claim` (see `domain/git-host.ts`);
 * without them the host is read-only for public repos and minting throws a
 * clear "not configured". `objectStoreConfig` carries the Garage credentials
 * that let the control plane mint presigned URLs — every byte uploaded or read
 * moves peer-to-peer, so these are the only secrets the store half needs.
 * `runtimeConfig` carries the lessee identity and Run-page URL (issue #17);
 * its defaults are good enough for a process that never executes
 * control-plane Steps (the OpenAPI generator), and real ones in production.
 */
export function createDeps(
  pool: Pool,
  githubConfig: GithubOAuthConfig,
  gitHostConfig: GithubAppConfig | undefined,
  keyring: KeyRing,
  objectStoreConfig?: S3ObjectStoreConfig,
  runtimeConfig: ControlPlaneRuntimeConfig = {
    controlPlaneInstanceId: "control-plane-unconfigured",
    runPageBaseUrl: "http://localhost:3000",
  },
  githubWebhookSecret: string = "unconfigured-webhook-secret",
): AppDeps {
  const clock = createSystemClock();
  return {
    db: createDatabase(pool),
    pool,
    clock,
    random: createSystemRandom(),
    githubOAuth: createGithubOAuthClient(githubConfig),
    gitHost: createGithubHost(gitHostConfig),
    notificationSender: createNotificationSender(),
    keyring,
    githubWebhookSecret,
    automationScheduleWatermark: { minute: null },
    claimHoldRangeMs: PRODUCTION_CLAIM_HOLD_RANGE_MS,
    claimLimiter: createClaimConnectionLimiter(MAX_HANGING_CLAIM_CONNECTIONS),
    liveTailHoldMs: LIVE_TAIL_HOLD_MS,
    objectStore: objectStoreConfig ? createS3ObjectStore(objectStoreConfig) : createNoopObjectStore(clock),
    liveTailLimiter: createClaimConnectionLimiter(MAX_HANGING_LIVE_TAIL_CONNECTIONS),
    controlPlaneInstanceId: runtimeConfig.controlPlaneInstanceId,
    runPageBaseUrl: runtimeConfig.runPageBaseUrl,
  };
}

function createNotificationSender(): NotificationSender {
  return {
    async send(url, payload) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        throw new Error(`notification webhook returned HTTP ${response.status}`);
      }
    },
  };
}

/**
 * Fallback object store for a process without Garage credentials configured
 * (the OpenAPI generator, local dev before env is set). Produces obviously-
 * fake URLs so the surface still boots; a real deployment always passes
 * `objectStoreConfig` from `main.ts`.
 */
function createNoopObjectStore(clock: Clock): ObjectStore {
  return {
    mintPutUrl: (key) =>
      Promise.resolve({ url: `https://blob.invalid/${key}?mock-presigned-put=1`, expiresAt: clock.now() }),
    mintGetUrl: (key) =>
      Promise.resolve({ url: `https://blob.invalid/${key}?mock-presigned-get=1`, expiresAt: clock.now() }),
    // No-op like the fake URLs above — a process without Garage credentials
    // never deletes anything real (the retention sweeper is only started by
    // `main.ts`, which requires Garage config).
    deleteObject: async () => {},
  };
}
