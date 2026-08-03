import { sql } from "drizzle-orm";
import { bigint, check, pgTable, text } from "drizzle-orm/pg-core";
import type { Id } from "@factory/shared";
import { projects } from "./projects.js";

/**
 * Identitas yang dapat memicu Run dan memiliki credential — seorang User atau
 * sebuah ServiceAccount (CONTEXT.md). `principals` ada sebagai tabel sendiri
 * dengan `users` dan `service_accounts` menunjuk padanya lewat `principal_id`
 * sebagai primary key mereka sendiri — bukan kolom `id` baru — sehingga
 * "credential menempel ke Principal" jadi satu foreign key, bukan sepasang
 * kolom nullable yang saling meniadakan (spec: "Skema database").
 *
 * `id` di sini adalah id yang dibangkitkan client dengan prefiks `user` atau
 * `serviceaccount` tergantung `kind` — satu identitas, bukan dua (spec: "Id").
 */
export const principals = pgTable(
  "principals",
  {
    id: text("id")
      .primaryKey()
      .$type<Id<"user"> | Id<"serviceaccount">>(),
    kind: text("kind").notNull().$type<"user" | "service_account">(),
  },
  (table) => [
    check("principals_kind_check", sql`${table.kind} in ('user', 'service_account')`),
  ],
);

/**
 * User: manusia yang masuk ke sistem (CONTEXT.md). Login GitHub OAuth
 * mengotentikasi (siapa kamu), tidak pernah mengotorisasi (boleh apa) — lihat
 * `org_members`/`project_members` untuk itu (spec: "Auth, tim, dan otorisasi").
 */
export const users = pgTable("users", {
  principalId: text("principal_id")
    .primaryKey()
    .references(() => principals.id)
    .$type<Id<"user">>(),
  // Null untuk akun break-glass — ia tidak punya identitas GitHub.
  githubUserId: bigint("github_user_id", { mode: "number" }).unique(),
  githubLogin: text("github_login"),
  name: text("name"),
  avatarUrl: text("avatar_url"),
  // Non-null hanya untuk akun break-glass lokal; login GitHub OAuth tidak
  // pernah punya password (spec: "satu akun break-glass lokal").
  passwordHash: text("password_hash"),
});

/**
 * ServiceAccount: Principal non-manusia milik sebuah Project, dipakai Run yang
 * dipicu Automation (CONTEXT.md). Kunci Project menempel ke ServiceAccount,
 * bukan ke Project, sehingga invarian "credential hanya di Principal" terjaga
 * struktural (spec: "Credential, secret, dan akses repo").
 */
export const serviceAccounts = pgTable("service_accounts", {
  principalId: text("principal_id")
    .primaryKey()
    .references(() => principals.id)
    .$type<Id<"serviceaccount">>(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id)
    .$type<Id<"project">>(),
  name: text("name").notNull(),
});
