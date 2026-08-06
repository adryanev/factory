/**
 * Bearer-secret generation and hashing for the Runner protocol — mirrors
 * `session-token.ts` exactly (same reasoning: only the SHA-256 hash is ever
 * written to Postgres, so a stolen backup or a read-only SQL console hands
 * out nothing usable). Two callers: `joinRunner` mints a fresh secret from
 * `/join`, and every other Runner-surface route hashes the bearer token it
 * receives to look up `runners.secret_hash`.
 *
 * The `rnr_` prefix is the "prefiks yang mengenali sumbernya" the spec asks
 * for (spec: "Otentikasi" — a token self-identifies its kind when it turns
 * up bare in a log line, without a database round trip).
 */
import { encodeBase32 } from "@factory/shared";
import { hashToken } from "./token-hash.js";

const SECRET_BYTE_LENGTH = 20; // 160 bits — same order of magnitude as the session token.
export const RUNNER_SECRET_PREFIX = "rnr_";
const DISPLAY_PREFIX_LENGTH = 8; // characters of the encoded body kept in `secretPrefix`, for audit display only — never enough to reconstruct the secret.

export function generateRunnerSecret(randomBytes: (length: number) => Uint8Array): string {
  return `${RUNNER_SECRET_PREFIX}${encodeBase32(randomBytes(SECRET_BYTE_LENGTH))}`;
}

export function hashRunnerSecret(secret: string): string {
  return hashToken(secret);
}

/** First few characters after the prefix — enough to recognize a token in an audit trail, never enough to brute-force it. */
export function runnerSecretDisplayPrefix(secret: string): string {
  return secret.slice(0, RUNNER_SECRET_PREFIX.length + DISPLAY_PREFIX_LENGTH);
}
