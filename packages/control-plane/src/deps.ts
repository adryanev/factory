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
import { createGithubHost, type GitHost } from "./domain/git-host.js";

export interface Clock {
  now(): Date;
}

export interface RandomSource {
  bytes(length: number): Uint8Array;
}

export interface AppDeps {
  db: Database;
  clock: Clock;
  random: RandomSource;
  githubOAuth: GithubOAuthClient;
  gitHost: GitHost;
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

/** Builds real (non-test) deps around an already-connected pool. `githubConfig` comes from the environment in `main.ts` — infra config, not the clock/random/network seams this file otherwise documents as injected. */
export function createDeps(pool: Pool, githubConfig: GithubOAuthConfig): AppDeps {
  return {
    db: createDatabase(pool),
    clock: createSystemClock(),
    random: createSystemRandom(),
    githubOAuth: createGithubOAuthClient(githubConfig),
    gitHost: createGithubHost(),
  };
}
