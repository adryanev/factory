import { bigint, integer, pgTable, primaryKey, text, unique } from "drizzle-orm/pg-core";
import type { Id } from "@factory/shared";
import { principals } from "./principals.js";
import { stepRuns } from "./step_runs.js";

/**
 * Apa pun yang dihasilkan sebuah StepRun untuk dibaca manusia — direkam dan
 * dapat diperiksa, tetapi tidak mengalir ke StepRun berikutnya (CONTEXT.md).
 * Immutable, satu per StepRun per key, tanpa tabel versi — suntingan manusia
 * di giliran ke-N adalah Artifact baru milik StepRun giliran ke-N (spec:
 * "Artifact dan blob"). `authoredByPrincipalId` non-null menandai "ditulis
 * manusia ke dalam artefak" — satu-satunya makna warna `--attention` (spec:
 * "Bahasa visual").
 *
 * `sizeBytes` disimpan karena kuota (1 GiB per artefak, 5 GiB per StepRun)
 * ditolak saat presigned URL diminta, sebelum byte naik (spec: "Artifact dan
 * blob") — pemeriksaan itu perlu menjumlah ukuran artefak yang sudah ada.
 */
export const artifacts = pgTable(
  "artifacts",
  {
    id: text("id").primaryKey().$type<Id<"artifact">>(),
    stepRunId: text("step_run_id")
      .notNull()
      .references(() => stepRuns.id)
      .$type<Id<"steprun">>(),
    key: text("key").notNull(),
    contentType: text("content_type").notNull(),
    blobKey: text("blob_key").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    authoredByPrincipalId: text("authored_by_principal_id")
      .references(() => principals.id)
      .$type<Id<"user"> | Id<"serviceaccount">>(),
  },
  (table) => [unique("artifacts_step_run_key_key").on(table.stepRunId, table.key)],
);

/**
 * Objek storage tidak bisa dibaca sambil ditulis, jadi log yang belum
 * selesai adalah banyak objek (spec: "Log"). Dedup di primary key `(step_run_id,
 * attempt, seq)`, bukan di kode — POST ulang jadi `ON CONFLICT DO NOTHING`.
 * `size` adalah ukuran yang DIDEKLARASIKAN Runner, bukan yang diverifikasi —
 * control plane tidak menghitung byte log sama sekali (spec: "Log").
 */
export const logChunks = pgTable(
  "log_chunks",
  {
    stepRunId: text("step_run_id")
      .notNull()
      .references(() => stepRuns.id)
      .$type<Id<"steprun">>(),
    attempt: integer("attempt").notNull(),
    seq: integer("seq").notNull(),
    byteOffset: bigint("byte_offset", { mode: "number" }).notNull(),
    size: integer("size").notNull(),
    blobKey: text("blob_key").notNull(),
  },
  (table) => [primaryKey({ columns: [table.stepRunId, table.attempt, table.seq] })],
);
