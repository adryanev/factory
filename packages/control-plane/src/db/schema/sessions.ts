import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { Id } from "@factory/shared";
import { users } from "./principals.js";

/**
 * One row per logged-in browser session (spec: "Auth, tim, dan otorisasi" —
 * "session disimpan di Postgres kita sendiri"). Not one of the 22 tables
 * enumerated in "Skema database" — that list predates this issue deciding
 * the session mechanism is cookie + Postgres row rather than something
 * stateless. Added as a new migration on top of the applied schema rather
 * than editing one, per this issue's instructions.
 *
 * `tokenHash` follows the same shape as `runner_join_tokens.token_hash`: the
 * bearer secret that goes in the cookie is never stored in the clear, only
 * its SHA-256 hash — a Postgres dump or read-only SQL access does not hand
 * out live sessions. `id` is the client-generated row id (for FK/audit
 * references); the cookie carries the raw token, not `id`.
 *
 * GitHub login and break-glass login write **the same shape** of row here —
 * nothing on this table distinguishes them. The only place that
 * distinguishes is `audit_log` (`auth.login_github` vs
 * `auth.login_breakglass`), per this issue's acceptance criteria.
 */
export const sessions = pgTable("sessions", {
  id: text("id").primaryKey().$type<Id<"session">>(),
  principalId: text("principal_id")
    .notNull()
    .references(() => users.principalId)
    .$type<Id<"user">>(),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});
