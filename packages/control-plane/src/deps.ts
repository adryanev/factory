/**
 * Composition-root dependency object. Every access to the clock or to
 * randomness goes through this — nothing in `src/` reads `Date.now()`,
 * `Math.random()`, or `crypto.getRandomValues()` directly, so a test can
 * swap in a fixed clock or a seeded random source and get a deterministic
 * run. This is a plain object, not a DI container: one composition root
 * (`main.ts` for the real process, each seam-1 test for its own instance)
 * builds it once and passes it to `createApp`.
 *
 * Outbound network calls (GitHub App, webhooks) have no caller yet — they
 * land with the issues that need them, following this same pattern: add a
 * field here, inject it, never read `fetch`/`http` ambiently from inside a
 * handler.
 */
import type { Pool } from "pg";
import { createDatabase, type Database } from "./db/client.js";

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

/** Builds real (non-test) deps around an already-connected pool. */
export function createDeps(pool: Pool): AppDeps {
  return {
    db: createDatabase(pool),
    clock: createSystemClock(),
    random: createSystemRandom(),
  };
}
