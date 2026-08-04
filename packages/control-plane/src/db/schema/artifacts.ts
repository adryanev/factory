import { sql } from "drizzle-orm";
import { bigint, check, integer, pgTable, primaryKey, text, timestamp, unique } from "drizzle-orm/pg-core";
import type { ArtifactKind, Id } from "@factory/shared";
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
 *
 * Tidak ada kolom konten: seluruh artefak ke blob, tidak ada jalur inline
 * Postgres (spec: "Semua ke blob, tanpa jalur inline Postgres"). `blobKey`
 * menunjuk ke objek `artifact/<step_run_id>/<key>` yang di-upload langsung
 * ke Garage.
 */
export const artifacts = pgTable(
  "artifacts",
  {
    id: text("id").primaryKey().$type<Id<"artifact">>(),
    stepRunId: text("step_run_id")
      .notNull()
      .references(() => stepRuns.id)
      .$type<Id<"steprun">>(),
    // Key ternormalisasi slug (spec: "key dinormalisasi slug — keunikan
    // memang tidak pernah dijanjikan di sini"). UNIQUE(step_run_id, key)
    // menegakkan "satu per StepRun per key" secara struktural; lintas
    // StepRun, key yang sama adalah konvensi, bukan constraint.
    key: text("key").notNull(),
    // Enum tertutup, text + CHECK (spec: "kind adalah enum tertutup").
    kind: text("kind").notNull().$type<ArtifactKind>(),
    contentType: text("content_type").notNull(),
    blobKey: text("blob_key").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    authoredByPrincipalId: text("authored_by_principal_id")
      .references(() => principals.id)
      .$type<Id<"user"> | Id<"serviceaccount">>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    unique("artifacts_step_run_key_key").on(table.stepRunId, table.key),
    check(
      "artifacts_kind_check",
      sql`${table.kind} in ('diff', 'transcript', 'document', 'structured', 'command-output', 'binary')`,
    ),
  ],
);

/**
 * Grant batch `/uploads` terakhir per (StepRun, attempt) — dasar semantik
 * "permintaan ulang mengganti grant sebelumnya, bukan menambah" (spec: nol
 * kunci baru; "`/uploads` mengganti grant sebelumnya alih-alih menambah,
 * sehingga kuota diperiksa atas satu daftar utuh dan tidak pernah hanyut").
 * Menyimpan metadata tiap grant — key ternormalisasi, kind blob-class
 * (artifact/session/log), size deklarasi (untuk kuota saat URL diminta),
 * dan blob_key yang benar-benar di-mint — sehingga:
 *
 *  - kuota 5 GiB per StepRun diperiksa atas satu daftar utuh di `/uploads`;
 *  - metadata yang menumpang `POST /result` hanya diterima bila (key, kind)
 *    ada di batch yang sekarang berlaku — artefak dari batch yang sudah
 *    diganti ditolak, dan dengan itu kuota tidak bisa hanyut lewat permintaan
 *    berulang;
 *  - blob_key artifact diambil dari sini, bukan dari laporan Runner — control
 *    plane memakai kunci yang ia sendiri mint, tidak pernah menuruti tebakan
 *    Runner tentang tata letak bucket.
 *
 * Log chunks memakai `/uploads` juga (satu grant per chunk), tetapi tidak
 * ikut batch: baris log tidak dibuat di sini, dan mint-nya jangan sampai
 * mengganti grant artifact/session giliran itu. Karena itu baris
 * artifact/session diganti sekaligus (DELETE kind in ('artifact','session')
 * lalu INSERT), sementara permintaan `kind: "log"` hanya di-mint tanpa
 * menyentuh tabel ini.
 */
export const stepRunUploadGrants = pgTable(
  "step_run_upload_grants",
  {
    stepRunId: text("step_run_id")
      .notNull()
      .references(() => stepRuns.id)
      .$type<Id<"steprun">>(),
    attempt: integer("attempt").notNull(),
    key: text("key").notNull(),
    kind: text("kind").notNull().$type<"artifact" | "session" | "log">(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
    blobKey: text("blob_key").notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.stepRunId, table.attempt, table.key, table.kind] }),
    check(
      "step_run_upload_grants_kind_check",
      sql`${table.kind} in ('artifact', 'session', 'log')`,
    ),
  ],
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
