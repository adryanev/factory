import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type { Id } from "@factory/shared";
import { principals } from "./principals.js";
import { projects } from "./projects.js";
import { repositories } from "./repositories.js";

/**
 * Satu eksekusi sebuah Pipeline, dari dipicu sampai berakhir (CONTEXT.md).
 * Tidak ada tabel `pipelines` — identitas Pipeline adalah `pipelineRepositoryId`
 * + `pipelinePath` (repo tuan rumah + path file), pasangan kolom di sini dan
 * di `pipeline_definition_cache` (spec: "Skema database").
 *
 * `definition` dan `definitionFiles` inline di Postgres — pengecualian
 * sengaja terhadap "semua artefak ke blob": ia bukan Artifact, jalur eksekusi
 * membacanya (materialisasi Graph + prompt tiap Step), dan ia harus hidup
 * persis selama baris Run (spec: "Artifact dan blob").
 *
 * `outcome` dan `endedAt` nullable, ditulis SEKALI oleh transaksi yang
 * mengakhiri Run — vonis akhir tidak bisa berubah lagi setelah itu. Jalur
 * penjadwalan tidak pernah membacanya; ia membaca `step_runs.outcome` (spec:
 * "Semantik eksekusi"). `endedAt` sekaligus predikat keempat sweep retensi.
 */
export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey().$type<Id<"run">>(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id)
      .$type<Id<"project">>(),
    pipelineRepositoryId: text("pipeline_repository_id")
      .notNull()
      .references(() => repositories.id)
      .$type<Id<"repository">>(),
    pipelinePath: text("pipeline_path").notNull(),
    // 'automation' = webhook atau jadwal (berjalan sebagai ServiceAccount);
    // 'manual' = tombol web (berjalan sebagai User yang menekannya), termasuk
    // rewind — rewind dibedakan lewat `parentRunId`, bukan trigger_kind baru
    // (spec: "Rewind = Run baru dengan parent_run_id").
    triggerKind: text("trigger_kind").notNull().$type<"automation" | "manual">(),
    triggeredByPrincipalId: text("triggered_by_principal_id")
      .notNull()
      .references(() => principals.id)
      .$type<Id<"user"> | Id<"serviceaccount">>(),
    // Terpisah dari triggeredByPrincipalId: credential yang dipakai bisa
    // beda dari Principal pemicu lewat `allowSharedAgentCredential` (spec:
    // "Cost" + "Credential, secret, dan akses repo").
    credentialPrincipalId: text("credential_principal_id")
      .notNull()
      .references(() => principals.id)
      .$type<Id<"user"> | Id<"serviceaccount">>(),
    refBranch: text("ref_branch").notNull(),
    refSha: text("ref_sha").notNull(),
    parentRunId: text("parent_run_id").references((): AnyPgColumn => runs.id).$type<Id<"run">>(),
    definition: jsonb("definition").notNull(),
    definitionFiles: jsonb("definition_files").notNull(),
    // Niat, bukan fakta — Cancel mengakui seketika di sini; efeknya (baris
    // step_runs jadi `cancelled`) ditulis terpisah (spec: "Kontrak API web ↔
    // control plane").
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    outcome: text("outcome").$type<"succeeded" | "failed" | "cancelled">(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    // Penanda retensi — lihat db/sql/retention_sweeps.sql. Nullable, dengan
    // partial index `(ended_at) WHERE ... IS NULL` supaya sweep-nya
    // menyusut sambil bekerja dan idempoten (spec: "Artifact dan blob").
    artifactsPurgedAt: timestamp("artifacts_purged_at", { withTimezone: true }),
    logsPurgedAt: timestamp("logs_purged_at", { withTimezone: true }),
    branchesPurgedAt: timestamp("branches_purged_at", { withTimezone: true }),
  },
  (table) => [
    check("runs_trigger_kind_check", sql`${table.triggerKind} in ('automation', 'manual')`),
    check(
      "runs_outcome_check",
      sql`${table.outcome} is null or ${table.outcome} in ('succeeded', 'failed', 'cancelled')`,
    ),
    // Keyset pagination: daftar Run terbaru per Project.
    index("runs_project_id_id_idx").on(table.projectId, table.id.desc()),
    // Dua filter himpunan tertutup paling sering: "sedang berjalan" (ended_at
    // IS NULL) dan "vonis akhir" (spec: "Kontrak API web ↔ control plane").
    index("runs_project_id_ended_at_id_idx").on(table.projectId, table.endedAt, table.id.desc()),
    // Dedup (Pipeline, SHA) — HARUS partial: polos atas seluruh baris akan
    // melarang rewind (parent_run_id lain, sha sama) dan tombol pemicu
    // manual. Berlaku hanya saat pemicunya automation dan bukan rewind (spec:
    // "Skema database"; issue 25-database-schema.md, bagian "Dedup").
    uniqueIndex("runs_pipeline_sha_automation_dedup")
      .on(table.pipelineRepositoryId, table.pipelinePath, table.refSha)
      .where(sql`${table.triggerKind} = 'automation' and ${table.parentRunId} is null`),
    index("runs_artifacts_retention_idx")
      .on(table.endedAt)
      .where(sql`${table.artifactsPurgedAt} is null`),
    index("runs_logs_retention_idx")
      .on(table.endedAt)
      .where(sql`${table.logsPurgedAt} is null`),
    index("runs_branches_retention_idx")
      .on(table.endedAt)
      .where(sql`${table.branchesPurgedAt} is null`),
  ],
);
