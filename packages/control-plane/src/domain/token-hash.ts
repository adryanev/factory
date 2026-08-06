/**
 * SHA-256 hex digest of a bearer token or one-time token — the one thing
 * ever written to Postgres for a session token, a Runner secret, or a
 * join token. Third occurrence of the identical pattern (session tokens,
 * Runner secrets, join tokens) is where this codebase's DRY rule says to
 * extract, not duplicate a fourth time (see `session-token.ts` and
 * `runner-secret.ts`, which both call this instead of `createHash`
 * themselves).
 */
import { createHash } from "node:crypto";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
