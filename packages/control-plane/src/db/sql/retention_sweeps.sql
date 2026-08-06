-- Ditulis tangan, bukan Drizzle: lima sweep retensi (spec: "Artifact dan
-- blob"; issue 25-database-schema.md bagian "Delivery webhook"), digerakkan
-- state Postgres bukan lifecycle rule bucket, masing-masing menuntut
-- `ended_at` sebagai predikat (spec: "Semantik eksekusi" — `runs.ended_at`
-- ditulis sekali saat Run berakhir) atau `received_at` (delivery webhook).
-- Pola seragam: kolom penanda `*_purged_at` nullable pada baris pemiliknya,
-- dengan partial index `(ended_at) WHERE <penanda> IS NULL` (didefinisikan
-- di db/schema/runs.ts, db/schema/step_runs.ts, dan db/schema/webhooks.ts)
-- sehingga tiap sweep adalah indexed scan yang MENYUSUT SAMBIL BEKERJA --
-- baris yang sudah di-purge lenyap dari kandidat berikutnya -- bukan
-- memindai ulang seluruh sejarah.

-- Tiap sweep adalah DUA langkah dijalankan aplikasi, bukan satu statement:
-- SELECT kandidat (indexed, dengan FOR UPDATE SKIP LOCKED supaya dua
-- instance sweep tidak memproses baris yang sama), aplikasi menghapus objek
-- Garage / branch git yang bersangkutan di luar transaksi SQL ini (untuk
-- delivery webhook tidak ada objek: satu-satunya kerja adalah UPDATE), LALU
-- UPDATE menandai `*_purged_at`. Idempoten: UPDATE hanya menyentuh baris
-- yang penandanya masih NULL, jadi menjalankan sweep dua kali -- termasuk
-- setelah gagal di tengah antara SELECT dan UPDATE -- aman; baris yang
-- gagal dihapus di Garage/GitHub cukup dicoba lagi di putaran berikutnya
-- karena penandanya belum tertulis.

-- Parameter tiap statement: $1 = batas jumlah baris per putaran (batch).

-- Tiap statement dibaca lewat penanda `-- name:` di atasnya, bukan lewat
-- posisinya di file: sepuluh statement yang diambil berdasarkan urutan
-- tetap lolos pemeriksaan jumlah setelah seseorang menukar urutannya, dan
-- salahnya baru kelihatan sebagai sweep yang menandai tabel yang keliru.

-- =====================================================================
-- 1. Artifact, 90 hari sejak Run berakhir (spec: "Artifact 90 hari sejak
--    Run berakhir").
-- =====================================================================

-- name: artifact_candidate
SELECT id
FROM runs
WHERE ended_at IS NOT NULL
  AND ended_at < now() - interval '90 days'
  AND artifacts_purged_at IS NULL
ORDER BY ended_at
LIMIT $1
FOR UPDATE SKIP LOCKED;

-- Setelah aplikasi menghapus blob Artifact di bawah prefix artifact/ milik
-- tiap run id di atas:
-- name: artifact_mark
UPDATE runs
SET artifacts_purged_at = now()
WHERE id = ANY($1::text[])
  AND artifacts_purged_at IS NULL;

-- =====================================================================
-- 2. Log, 30 hari sejak Run berakhir (spec: "Log 30 hari sejak Run
--    berakhir").
-- =====================================================================

-- name: log_candidate
SELECT id
FROM runs
WHERE ended_at IS NOT NULL
  AND ended_at < now() - interval '30 days'
  AND logs_purged_at IS NULL
ORDER BY ended_at
LIMIT $1
FOR UPDATE SKIP LOCKED;

-- Setelah aplikasi menghapus blob log_chunks di bawah prefix log/ milik
-- tiap run id di atas:
-- name: log_mark
UPDATE runs
SET logs_purged_at = now()
WHERE id = ANY($1::text[])
  AND logs_purged_at IS NULL;

-- =====================================================================
-- 3. Branch, saat Run berakhir -- tanpa jendela tunggu, ambang efektif nol
--    (spec: "Branch saat Run berakhir").
-- =====================================================================

-- name: branch_candidate
SELECT id
FROM runs
WHERE ended_at IS NOT NULL
  AND branches_purged_at IS NULL
ORDER BY ended_at
LIMIT $1
FOR UPDATE SKIP LOCKED;

-- Setelah aplikasi menghapus branch git `run/<run-id>/...` di Git Remote
-- milik tiap run id di atas (branch setengah jadi yang gagal dihapus dicoba
-- lagi putaran berikutnya -- penandanya belum tertulis):
-- name: branch_mark
UPDATE runs
SET branches_purged_at = now()
WHERE id = ANY($1::text[])
  AND branches_purged_at IS NULL;

-- =====================================================================
-- 4. Session, saat StepRun tak lagi `awaiting-human` DAN Run berakhir (spec:
--    "Session saat StepRun tak lagi awaiting-human dan Run berakhir"). Dua
--    predikat, dua tabel -- join ke runs untuk ended_at, index di step_runs
--    untuk sisanya (definisi di db/schema/step_runs.ts).
-- =====================================================================

-- name: session_candidate
SELECT step_runs.id
FROM step_runs
JOIN runs ON runs.id = step_runs.run_id
WHERE runs.ended_at IS NOT NULL
  AND step_runs.outcome <> 'awaiting-human'
  AND step_runs.session_blob_key IS NOT NULL
  AND step_runs.session_purged_at IS NULL
ORDER BY runs.ended_at
LIMIT $1
FOR UPDATE OF step_runs SKIP LOCKED;

-- Setelah aplikasi menghapus blob session di bawah prefix session/ milik
-- tiap step_run id di atas:
-- name: session_mark
UPDATE step_runs
SET session_purged_at = now()
WHERE id = ANY($1::text[])
  AND session_purged_at IS NULL;

-- =====================================================================
-- 5. Delivery webhook, 24 jam (spec: "Sweep webhook_deliveries 24 jam
--    memakai pola penanda yang sama"). Baris ini tidak menunjuk blob apa
--    pun — tidak ada prefix bucket yang dihapus di antara SELECT dan
--    UPDATE; satu-satunya kerja aplikasi adalah menulis penandanya.
--    Ambang `received_at`, bukan `ended_at`: tabel ini tidak punya Run.
-- =====================================================================

-- name: webhook_candidate
SELECT delivery_id
FROM webhook_deliveries
WHERE received_at < now() - interval '24 hours'
  AND purged_at IS NULL
ORDER BY received_at
LIMIT $1
FOR UPDATE SKIP LOCKED;

-- name: webhook_mark
UPDATE webhook_deliveries
SET purged_at = now()
WHERE delivery_id = ANY($1::text[])
  AND purged_at IS NULL;
