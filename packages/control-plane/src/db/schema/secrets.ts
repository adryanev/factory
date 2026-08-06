import { customType, integer, pgTable, text, unique } from "drizzle-orm/pg-core";
import type { Id } from "@factory/shared";
import { principals } from "./principals.js";
import { projects } from "./projects.js";

// drizzle-orm/pg-core has no built-in `bytea` column; this is the standard
// customType recipe for it.
const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/**
 * Secret Project dan credential agent, terenkripsi AES-256-GCM dengan AAD =
 * id secret + id Principal pemilik, sehingga baris yang disalin ke Principal
 * lain gagal didekripsi — invarian ditegakkan kriptografis, bukan oleh
 * `WHERE` (spec: "Credential, secret, dan akses repo"). Nonce dan auth tag
 * kolom terpisah, bukan disambung jadi satu `bytea`, supaya panjang yang
 * salah mustahil ditulis diam-diam. `key_version` per baris membuat rotasi
 * master key inkremental dan bisa diinterupsi tanpa mengganggu Run berjalan.
 */
export const secrets = pgTable(
  "secrets",
  {
    id: text("id").primaryKey().$type<Id<"secret">>(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id)
      .$type<Id<"project">>(),
    ownerPrincipalId: text("owner_principal_id")
      .notNull()
      .references(() => principals.id)
      .$type<Id<"user"> | Id<"serviceaccount">>(),
    name: text("name").notNull(),
    ciphertext: bytea("ciphertext").notNull(),
    nonce: bytea("nonce").notNull(),
    authTag: bytea("auth_tag").notNull(),
    keyVersion: integer("key_version").notNull(),
  },
  (table) => [unique("secrets_project_name_key").on(table.projectId, table.name)],
);
