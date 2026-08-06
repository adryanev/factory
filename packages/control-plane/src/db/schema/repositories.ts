import { bigint, pgTable, text, unique } from "drizzle-orm/pg-core";
import type { Id } from "@factory/shared";
import { projects } from "./projects.js";

/**
 * Pendaftaran webhook jatuh gratis dari GitHub App: satu endpoint, satu
 * secret, nol pemasangan per repo (spec: "Automation"). Sebuah Project boleh
 * menyambungkan lebih dari satu installation (mis. repo tersebar di lebih
 * dari satu akun/organisasi GitHub).
 */
export const githubAppInstallations = pgTable("github_app_installations", {
  id: text("id").primaryKey().$type<Id<"installation">>(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id)
    .$type<Id<"project">>(),
  installationId: bigint("installation_id", { mode: "number" }).notNull().unique(),
  accountLogin: text("account_login").notNull(),
});

/**
 * Repositori git yang menjadi anggota sebuah Project (CONTEXT.md). Satu repo
 * GitHub menjadi anggota tepat satu Project — Project adalah batas keamanan.
 * `defaultBranch` disimpan karena Pipeline lintas repo dibaca dari default
 * branch-nya (spec: "Automation"), dan webhook push perlu tahu ref itu tanpa
 * menembak GitHub tiap kejadian.
 */
export const repositories = pgTable(
  "repositories",
  {
    id: text("id").primaryKey().$type<Id<"repository">>(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id)
      .$type<Id<"project">>(),
    githubAppInstallationId: text("github_app_installation_id")
      .notNull()
      .references(() => githubAppInstallations.id)
      .$type<Id<"installation">>(),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    defaultBranch: text("default_branch").notNull(),
  },
  (table) => [unique("repositories_owner_name_key").on(table.owner, table.name)],
);
