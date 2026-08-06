import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { Id } from "@factory/shared";
import { projects } from "./projects.js";
import { repositories } from "./repositories.js";

/**
 * `concurrency: queue` — antrean pemicu automation sedalam satu per
 * (Pipeline, ref) (ticket 22: "Antrean sedalam satu: Run ketiga menggantikan
 * Run kedua yang masih mengantre"). Saat pemicu tiba dan ada Run aktif untuk
 * (Pipeline, ref) yang sama, definisi + file prompt dibaca seketika (semantik
 * "definisi dari ref yang dipicu" tetap, bukan dari ref yang sudah bergeser
 * saat antrean dikuras) dan disimpan sebagai snapshot di baris ini; `ON
 * CONFLICT` pada kunci unik menggantikan entri lama — entri ketiga
 * menggantikan yang kedua. Sweep menguras baris yang kuncinya tidak lagi
 * punya Run aktif. Cron tidak pernah antre — cron selalu skip (ticket 22).
 */
export const pendingAutomationRuns = pgTable(
  "pending_automation_runs",
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
    refBranch: text("ref_branch").notNull(),
    refSha: text("ref_sha").notNull(),
    definition: jsonb("definition").notNull(),
    definitionFiles: jsonb("definition_files").notNull(),
    serviceAccountPrincipalId: text("service_account_principal_id").notNull().$type<Id<"serviceaccount">>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("pending_automation_runs_pipeline_ref_key").on(
      table.pipelineRepositoryId,
      table.pipelinePath,
      table.refBranch,
    ),
    index("pending_automation_runs_created_at_idx").on(table.createdAt),
  ],
);

/**
 * Cron yang dilewati karena tumpang tindih — "pelewatannya terlihat di UI"
 * (ticket 22): sebuah jadwal yang tiba saat masih ada Run aktif untuk
 * (Pipeline, ref) yang sama tidak mengantre (cron yang mengantre menumpuk
 * tanpa batas), ia dilewati, dan pelewatannya dicatat sebagai baris yang
 * dibaca halaman daftar Run. Entri dengan `refSha` sama dengan SHA yang baru
 * akan dijalankan bukanlah skip — itu dedup (Pipeline, SHA), yang tetap diam.
 */
export const cronSkips = pgTable(
  "cron_skips",
  {
    id: text("id").primaryKey().$type<Id<"skip">>(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id)
      .$type<Id<"project">>(),
    pipelineRepositoryId: text("pipeline_repository_id")
      .notNull()
      .references(() => repositories.id)
      .$type<Id<"repository">>(),
    pipelinePath: text("pipeline_path").notNull(),
    refBranch: text("ref_branch").notNull(),
    refSha: text("ref_sha").notNull(),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    skippedAt: timestamp("skipped_at", { withTimezone: true }).notNull(),
    reason: text("reason").notNull(),
  },
  (table) => [
    check("cron_skips_reason_check", sql`${table.reason} in ('run-active')`),
    index("cron_skips_project_id_id_idx").on(table.projectId, table.id.desc()),
  ],
);
