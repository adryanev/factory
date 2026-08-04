import { sql } from "drizzle-orm";
import { boolean, check, jsonb, pgTable, primaryKey, text, unique } from "drizzle-orm/pg-core";
import type { Id } from "@factory/shared";
import { DEFAULT_EGRESS_ALLOWLIST } from "../../domain/egress-policy.js";
import { users } from "./principals.js";

/**
 * Unit isolasi. Anggota, peran, credential, secret, ServiceAccount, Pipeline,
 * dan Repository semuanya menempel padanya (CONTEXT.md).
 */
export const projects = pgTable("projects", {
  id: text("id").primaryKey().$type<Id<"project">>(),
  name: text("name").notNull(),
  // Sakelar insiden: mematikan semua pemicu otomatis satu Project tanpa PR ke
  // tiap repo (spec: "Automation"). Bawaan menyala.
  automationEnabled: boolean("automation_enabled").notNull().default(true),
  // Fallback User→ServiceAccount untuk credential agent, bawaan mati (spec:
  // "Credential, secret, dan akses repo").
  allowSharedAgentCredential: boolean("allow_shared_agent_credential").notNull().default(false),
  // Izin sadar per Project untuk `runsOn: [exec:host]`, bawaan mati (spec:
  // "saya ingin mode eksekusi langsung di host jadi izin ... sadar per Project").
  hostExecAllowed: boolean("host_exec_allowed").notNull().default(false),
  // Default-deny egress dari Sandbox; allowlist per Project ini adalah
  // satu-satunya pengecualian. Perubahan dicatat di audit log (spec:
  // "Default-deny egress dari Sandbox; allowlist per Project masuk daftar
  // audit"). Default = allowlist bawaan (`egress-policy.ts`).
  egressAllowlist: jsonb("egress_allowlist").$type<string[]>().notNull().default(DEFAULT_EGRESS_ALLOWLIST),
  // Satu outgoing webhook per Project — kolom di sini, bukan tabel tersendiri,
  // karena tidak ada kardinalitas untuk dimodelkan (spec: "Notifikasi").
  notificationWebhookUrl: text("notification_webhook_url"),
});

/**
 * Peran per Project: `admin` + `member` (spec: "Auth, tim, dan otorisasi").
 * `maintainer` ditolak sengaja — dipisahkan "menulis Pipeline" dari
 * "menjalankan Pipeline" tidak berarti untuk tim internal.
 */
export const projectMembers = pgTable(
  "project_members",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id)
      .$type<Id<"project">>(),
    principalId: text("principal_id")
      .notNull()
      .references(() => users.principalId)
      .$type<Id<"user">>(),
    role: text("role").notNull().$type<"admin" | "member">(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.principalId] }),
    check("project_members_role_check", sql`${table.role} in ('admin', 'member')`),
  ],
);

/**
 * Himpunan bernama berisi anggota Project, dipakai untuk menyebut siapa yang
 * diminta menjawab sebuah Question — "siapa yang ditanya", bukan "siapa yang
 * boleh apa" (CONTEXT.md). Nama harus unik per Project karena `ask: { group:
 * <name> }` di YAML merujuknya lewat nama, bukan id.
 */
export const groups = pgTable(
  "groups",
  {
    id: text("id").primaryKey().$type<Id<"group">>(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id)
      .$type<Id<"project">>(),
    name: text("name").notNull(),
  },
  (table) => [unique("groups_project_name_key").on(table.projectId, table.name)],
);

/**
 * Anggota Group selalu anggota Project yang sama (CONTEXT.md), jadi FK-nya ke
 * `users`, bukan ke `principals` — Group tidak pernah jadi jalur akses.
 */
export const groupMembers = pgTable(
  "group_members",
  {
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id)
      .$type<Id<"group">>(),
    principalId: text("principal_id")
      .notNull()
      .references(() => users.principalId)
      .$type<Id<"user">>(),
  },
  (table) => [primaryKey({ columns: [table.groupId, table.principalId] })],
);
