/**
 * The session cookie carries a bearer secret, not the session row's id.
 * Only its SHA-256 hash is ever written to Postgres, mirroring
 * `runner_join_tokens.token_hash` — a stolen backup or a read-only SQL
 * console does not hand out working sessions. Hashing is deterministic
 * (no clock, no randomness), so it isn't routed through `AppDeps`; token
 * *generation* is randomness and does go through the injected
 * `RandomSource` (see `deps.ts`) — callers pass bytes in, this module never
 * reads `crypto.getRandomValues` itself.
 */
import { createHash } from "node:crypto";
import { encodeBase32 } from "@factory/shared";

const TOKEN_BYTE_LENGTH = 20; // 160 bits — same order of magnitude as a UUIDv4's random bits

export function generateSessionToken(randomBytes: (length: number) => Uint8Array): string {
  return encodeBase32(randomBytes(TOKEN_BYTE_LENGTH));
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
