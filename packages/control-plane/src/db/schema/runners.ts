import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { Id } from "@factory/shared";
import { principals } from "./principals.js";

/**
 * Mesin terdaftar yang menarik pekerjaan dari control plane dan menjalankannya
 * (CONTEXT.md). Satu kolam Runner milik ORG, bukan per Project — tidak ada
 * `project_id` di sini (spec: "Runner: siklus hidup dan penjadwalan").
 * Identitas ada di file yang ditulis Runner saat join (id + secret), bukan
 * di hostname atau IP.
 *
 * `desiredState` satu kolom membawa drain DAN revoke sekaligus — revoke
 * adalah fencing, bukan pembunuhan (spec: "Runner: siklus hidup dan
 * penjadwalan").
 */
export const runners = pgTable(
  "runners",
  {
    id: text("id").primaryKey().$type<Id<"runner">>(),
    secretHash: text("secret_hash").notNull(),
    secretPrefix: text("secret_prefix").notNull(),
    desiredState: text("desired_state")
      .notNull()
      .default("active")
      .$type<"active" | "draining" | "revoked">(),
    // Kebijakan ditulis operator: label yang Pipeline minta lewat `runsOn`,
    // dievaluasi sebagai containment di kueri klaim (spec: "Runner: siklus
    // hidup dan penjadwalan").
    tags: text("tags").array().notNull().default([]),
    slots: integer("slots").notNull(),
    capsHash: text("caps_hash"),
    // Fakta diprobe tiap start: exec mode, agent CLI terpasang, cpu/ram
    // (spec: "Runner: siklus hidup dan penjadwalan").
    capabilities: jsonb("capabilities"),
    protocolVersion: integer("protocol_version"),
    // Dipakai UI menandai Runner yang versinya terlalu tua (spec: "saya
    // ingin melihat mesin yang versinya terlalu tua ditandai di UI").
    releaseVersion: text("release_version"),
    // Ambang online 30 detik dihitung dari sini; heartbeat tiap 10 detik
    // (spec: "Runner: siklus hidup dan penjadwalan").
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "runners_desired_state_check",
      sql`${table.desiredState} in ('active', 'draining', 'revoked')`,
    ),
    index("runners_tags_gin_idx").using("gin", table.tags),
  ],
);

/**
 * Token sekali pakai yang menukar jadi runner-id + secret (spec: "saya ingin
 * mendaftarkan sebuah mesin ke kolam dengan satu token sekali pakai").
 * `usedAt` non-null mencegah pemakaian ulang lewat compare-and-set di
 * aplikasi (`UPDATE ... WHERE used_at IS NULL`).
 */
export const runnerJoinTokens = pgTable("runner_join_tokens", {
  id: text("id").primaryKey().$type<Id<"jointoken">>(),
  tokenHash: text("token_hash").notNull().unique(),
  createdByPrincipalId: text("created_by_principal_id")
    .notNull()
    .references(() => principals.id)
    .$type<Id<"user"> | Id<"serviceaccount">>(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  runnerId: text("runner_id")
    .references(() => runners.id)
    .$type<Id<"runner">>(),
});
