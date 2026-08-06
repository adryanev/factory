-- Ditulis tangan, bukan Drizzle: kueri terpanas sistem ini (ticket 07,
-- dipakai ulang oleh Step `kind: pull-request` dengan lessee = instance
-- control plane, ticket 24). Drizzle tidak bisa menyatakan `FOR UPDATE SKIP
-- LOCKED` di atas subquery berkorelasi, UPDATE bersyarat dengan cek baris
-- terpengaruh, dan containment tag di satu statement tanpa escape hatch, jadi
-- ini ditulis tangan dan diberi contract test langsung ke Postgres (spec:
-- "Skema database").
--
-- Bentuknya: SELECT kandidat dengan FOR UPDATE SKIP LOCKED (baris yang
-- sedang dikunci klaim lain dilewati, bukan ditunggu), lalu UPDATE
-- bersyarat. Baris terpengaruh (RETURNING mengembalikan 0 atau 1 baris) yang
-- memberi tahu pemanggil apakah klaim berhasil.
--
-- `lease_token`: `gen_random_uuid()`, bukan `gen_random_bytes()` + `encode()`
-- — keduanya sama-sama acak kriptografis, tapi `gen_random_uuid()` sudah ada
-- di Postgres core sejak v13 sementara `gen_random_bytes()` menuntut
-- ekstensi `pgcrypto` yang tidak dinyalakan di migrasi manapun (dibuktikan
-- gagal oleh contract test: `function gen_random_bytes(integer) does not
-- exist`) — menambah satu langkah `CREATE EXTENSION` demi fungsi yang
-- core-nya sudah cukup tidak sepadan.
--
-- Parameter:
--   $1  lessee_id       text     -- runner_id, ATAU id instance control plane
--                                    untuk Step kind: pull-request
--   $2  runner_tags     text[]   -- tag yang dibawa Runner; '{}' untuk
--                                    lessee control plane (Step control-plane
--                                    tidak punya runsOn)
--   $3  slots           int      -- kapasitas lessee ini
--   $4  lease_seconds   int      -- 30 untuk StepRun biasa (spec: "Runner:
--                                    siklus hidup dan penjadwalan"), 60 untuk
--                                    kind: pull-request (spec: "Step yang
--                                    dieksekusi control plane")
--   $5  wanted_kind     text|null -- NULL untuk klaim Runner biasa,
--                                    'pull-request' untuk control plane
--
-- Fence `count(*) < $3`: dihitung dari StepRun yang SEDANG dipegang lessee
-- ini dengan lease belum kedaluwarsa -- bukan angka self-report Runner --
-- itulah yang membuatnya pagar sungguhan, bukan sekadar informasi (spec:
-- "Runner: siklus hidup dan penjadwalan"). Penegakan utama slot tetap di sisi
-- Runner (penuh → berhenti poll); ini backstop server-side.
--
-- Containment: `required_tags <@ $2` berarti "semua tag yang Step minta ada
-- di tag yang Runner bawa" -- ekuivalen `runner.tags @> requires` ditulis
-- dari sisi StepRun (spec: "Runner: siklus hidup dan penjadwalan").
--
-- `ORDER BY ready_at`: FIFO murni, tanpa prioritas (aditif, ditunda -- lihat
-- "Out of Scope").

WITH candidate AS (
  SELECT id
  FROM step_runs
  WHERE outcome = 'ready'
    AND kind IS NOT DISTINCT FROM $5
    AND required_tags <@ $2::text[]
    AND (
      SELECT count(*)
      FROM step_runs held
      WHERE held.leased_by = $1
        AND held.lease_expires_at > now()
    ) < $3
  ORDER BY ready_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
UPDATE step_runs
SET outcome = 'running',
    leased_by = $1,
    lease_token = gen_random_uuid()::text,
    lease_expires_at = now() + ($4 * interval '1 second'),
    started_at = coalesce(step_runs.started_at, now())
FROM candidate
WHERE step_runs.id = candidate.id
RETURNING step_runs.*;
