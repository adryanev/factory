import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import type { Id } from "@factory/shared";
import { repositories } from "./repositories.js";
import { runs } from "./runs.js";

/**
 * Satu eksekusi sebuah Step di dalam sebuah Run (CONTEXT.md). Kunci natural
 * `(run_id, step_key, branch_key, turn)` dengan `NULLS NOT DISTINCT`:
 * `branch_key` NULL berarti Step ini tidak punya Key (non-fan-out) — NULL
 * berarti apa adanya, sentinel `''` ditolak lewat CHECK di bawah. Constraint
 * ini sekaligus yang menegakkan "Key duplikat menggagalkan Run" secara
 * struktural (spec: "Skema database"). Giliran (`turn`) melahirkan baris
 * baru; `attempt` menghitung ulang di dalamnya — dua penomoran terpisah, dan
 * retry menimpa baris yang sama, bukan menyisipkan baris baru (spec:
 * "Semantik eksekusi").
 *
 * `outcome` adalah satu-satunya nilai yang disimpan selagi Run bergerak.
 * "Hilir dijadwalkan" dan vonis akhir Run dihitung, tidak pernah disimpan di
 * sini (spec: "Semantik eksekusi").
 */
export const stepRuns = pgTable(
  "step_runs",
  {
    id: text("id").primaryKey().$type<Id<"steprun">>(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id)
      .$type<Id<"run">>(),
    // Satu StepRun menyentuh satu repo saja, termasuk pada fan-out lintas
    // repo dengan Key nama repo (spec: "saya ingin kerja lintas repo
    // berbentuk fan-out dengan Key nama repo, agar tiap StepRun tetap
    // menyentuh satu repo saja").
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id)
      .$type<Id<"repository">>(),
    stepKey: text("step_key").notNull(),
    branchKey: text("branch_key"),
    turn: integer("turn").notNull(),
    attempt: integer("attempt").notNull().default(1),
    outcome: text("outcome")
      .notNull()
      .default("ready")
      .$type<
        | "ready"
        | "running"
        | "awaiting-human"
        | "succeeded"
        | "failed"
        | "skipped"
        | "cancelled"
      >(),
    // Satu penghitung `attempt` untuk semua sebab kegagalan (termasuk lease
    // hilang dan output-invalid), dengan `reason` dicatat terpisah (spec:
    // "Semantik eksekusi"). Bukan CHECK tertutup: himpunan sebab kegagalan
    // tidak terdaftar lengkap di sumber yang dibaca untuk skema ini — lihat
    // laporan.
    reason: text("reason"),
    // NULL = Step biasa, diklaim Runner. 'pull-request' = Step control-plane,
    // tak pernah diklaim Runner, dieksekusi lewat kueri lease yang sama
    // dengan lessee instance control plane (spec: "Step yang dieksekusi
    // control plane").
    kind: text("kind").$type<"pull-request">(),
    // Kebutuhan Runner (label), dievaluasi sebagai containment
    // `runner.tags @> requiredTags` di dalam kueri klaim (spec: "Runner:
    // siklus hidup dan penjadwalan"; db/sql/claim_step_run.sql).
    requiredTags: text("required_tags").array().notNull().default([]),
    // Menggerakkan `ORDER BY ready_at` di kueri klaim — FIFO murni, tanpa
    // prioritas (spec: "Runner: siklus hidup dan penjadwalan").
    readyAt: timestamp("ready_at", { withTimezone: true }).notNull(),
    // Wall clock timeout dipegang control plane, bukan sandcastle (spec:
    // "jam wall-clock hanya satu dan dipegang control plane").
    startedAt: timestamp("started_at", { withTimezone: true }),
    // `leasedBy` bisa berisi runner_id ATAU id instance control plane (untuk
    // kind: pull-request) — bukan FK ke `runners` karena lessee-nya
    // polimorfik (spec: "Step yang dieksekusi control plane").
    leasedBy: text("leased_by"),
    // Idempotency key `/result` — sama → 200 dengan hasil yang sudah
    // tercatat; beda → 409, Runner ter-fence (spec: "Kontrak API
    // control-plane ↔ Runner").
    leaseToken: text("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    // Output: satu Ref plus data terstruktur tervalidasi skema — satu-
    // satunya yang mengalir ke StepRun berikutnya (CONTEXT.md). Ditulis
    // sekali saat giliran berakhir sukses; retry menimpa baris yang sama.
    outputRefBranch: text("output_ref_branch"),
    outputRefSha: text("output_ref_sha"),
    outputData: jsonb("output_data"),
    // Lokasi session di blob store, diunggah sebelum POST Question — dibaca
    // giliran lanjutan lewat presigned GET di muatan `/claim` (spec: "Step
    // yang menunggu manusia").
    sessionBlobKey: text("session_blob_key"),
    // Retensi: saat StepRun tak lagi `awaiting-human` DAN Run berakhir (spec:
    // "Artifact dan blob"). Lihat db/sql/retention_sweeps.sql.
    sessionPurgedAt: timestamp("session_purged_at", { withTimezone: true }),
  },
  (table) => [
    unique("step_runs_natural_key")
      .on(table.runId, table.stepKey, table.branchKey, table.turn)
      .nullsNotDistinct(),
    check(
      "step_runs_branch_key_not_empty_check",
      sql`${table.branchKey} is null or length(${table.branchKey}) > 0`,
    ),
    check(
      "step_runs_outcome_check",
      sql`${table.outcome} in ('ready', 'running', 'awaiting-human', 'succeeded', 'failed', 'skipped', 'cancelled')`,
    ),
    check("step_runs_kind_check", sql`${table.kind} is null or ${table.kind} = 'pull-request'`),
    // Kueri klaim terpanas sistem ini: `WHERE outcome = 'ready' ... ORDER BY
    // ready_at` (db/sql/claim_step_run.sql). Partial index karena hanya baris
    // `ready` yang pernah discan olehnya.
    index("step_runs_ready_claim_idx")
      .on(table.readyAt)
      .where(sql`${table.outcome} = 'ready'`),
    // Containment tag `runner.tags @> requiredTags` butuh GIN.
    index("step_runs_required_tags_gin_idx").using("gin", table.requiredTags),
    // Sweep retensi session: baris yang belum di-purge dan bukan lagi
    // awaiting-human — join ke runs.ended_at menentukan sisanya.
    index("step_runs_session_retention_idx")
      .on(table.runId)
      .where(
        sql`${table.sessionPurgedAt} is null and ${table.outcome} <> 'awaiting-human' and ${table.sessionBlobKey} is not null`,
      ),
  ],
);

/**
 * Biaya, insert-only, satu baris per attempt — retry tidak bisa menimpanya
 * karena retry tidak menulis ke sini sama sekali. "Kumulatif lintas attempt"
 * jadi `SUM` biasa; tidak ada kolom yang perlu di-reset (spec: "Cost";
 * issue 25-database-schema.md, bagian "Biaya").
 *
 * `tokens`/`costUsd`/`priceVersion` nullable bersama: agent yang tidak
 * melaporkan pemakaian tetap dapat baris (untuk kelengkapan pencatatan per
 * attempt), ditampilkan sebagai "tidak didukung", bukan sebagai angka
 * perkiraan (spec: "Cost").
 */
export const stepRunCosts = pgTable(
  "step_run_costs",
  {
    stepRunId: text("step_run_id")
      .notNull()
      .references(() => stepRuns.id)
      .$type<Id<"steprun">>(),
    attempt: integer("attempt").notNull(),
    tokens: jsonb("tokens"),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    priceVersion: text("price_version"),
  },
  (table) => [primaryKey({ columns: [table.stepRunId, table.attempt] })],
);
