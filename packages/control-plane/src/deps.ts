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
 */
export function createDeps(
  pool: Pool,
  githubConfig: GithubOAuthConfig,
  gitHostConfig: GithubAppConfig | undefined,
  keyring: KeyRing,
  objectStoreConfig?: S3ObjectStoreConfig,
): AppDeps {
  const clock = createSystemClock();
  return {
    db: createDatabase(pool),
    pool,
    clock,
    random: createSystemRandom(),
    githubOAuth: createGithubOAuthClient(githubConfig),
    gitHost: createGithubHost(gitHostConfig),
    keyring,
    claimHoldRangeMs: PRODUCTION_CLAIM_HOLD_RANGE_MS,
    claimLimiter: createClaimConnectionLimiter(MAX_HANGING_CLAIM_CONNECTIONS),
    liveTailHoldMs: LIVE_TAIL_HOLD_MS,
    objectStore: objectStoreConfig ? createS3ObjectStore(objectStoreConfig) : createNoopObjectStore(clock),
    liveTailLimiter: createClaimConnectionLimiter(MAX_HANGING_LIVE_TAIL_CONNECTIONS),
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
  };
}
