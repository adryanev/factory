import { sql } from "drizzle-orm";
import { check, pgTable, text } from "drizzle-orm/pg-core";
import type { Id } from "@factory/shared";
import { users } from "./principals.js";

/**
 * Keanggotaan dan peran org, ditentukan di sistem kami sendiri — identitas
 * GitHub hanya menjawab "siapa kamu", tidak pernah "boleh apa" (spec: "Auth,
 * tim, dan otorisasi"). Hanya User yang jadi anggota org (ServiceAccount
 * milik Project, bukan org). `owner` tidak otomatis dapat akses data Project;
 * ia harus menambahkan dirinya jadi `project_members`, dan tindakan itu
 * teraudit — lihat `audit_log`.
 */
export const orgMembers = pgTable(
  "org_members",
  {
    principalId: text("principal_id")
      .primaryKey()
      .references(() => users.principalId)
      .$type<Id<"user">>(),
    role: text("role").notNull().default("member").$type<"owner" | "member">(),
  },
  (table) => [check("org_members_role_check", sql`${table.role} in ('owner', 'member')`)],
);
