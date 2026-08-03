import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { Id } from "@factory/shared";
import { principals } from "./principals.js";
import { projects } from "./projects.js";

/**
 * Catatan audit yang tidak bisa diubah atau dihapus (spec: "saya ingin
 * catatan audit yang tidak bisa diubah atau dihapus"). Append-only
 * ditegakkan lewat trigger DB, bukan REVOKE — lihat
 * `db/sql/audit_log_append_only.sql`. Nilai secret tidak pernah dicatat.
 *
 * `project_id` nullable: sebagian kejadian (mis. perubahan `org_members`,
 * login break-glass) tidak melekat ke satu Project.
 *
 * `action` sengaja `text` tanpa CHECK: spec menyebut "sepuluh jenis
 * kejadian" tapi tidak mendaftar nilainya secara literal di sumber yang
 * dibaca untuk skema ini — lihat laporan, ini ditandai sebagai pertanyaan
 * terbuka, bukan diasumsikan.
 */
export const auditLog = pgTable("audit_log", {
  id: text("id").primaryKey().$type<Id<"audit">>(),
  projectId: text("project_id")
    .references(() => projects.id)
    .$type<Id<"project">>(),
  actorPrincipalId: text("actor_principal_id")
    .notNull()
    .references(() => principals.id)
    .$type<Id<"user"> | Id<"serviceaccount">>(),
  action: text("action").notNull(),
  targetType: text("target_type"),
  targetId: text("target_id"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
