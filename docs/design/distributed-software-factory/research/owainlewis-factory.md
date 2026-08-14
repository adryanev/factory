# owainlewis/factory — analisis build-vs-buy

**Commit terverifikasi:** `88a5093` (chore: bump actions/setup-node, 2 jam sebelum riset ini — commit substantif terakhir berkisar di `295badb`, dirujuk di `ARCHITECTURE.md:5`).
**Lisensi:** MIT, sungguhan (`LICENSE`, Copyright (c) 2026 Owain Lewis) — bukan klaim README yang tidak didukung file.
**Stack:** Go (control plane + worker), SQLite (`modernc.org/sqlite`, driver pure-Go, tanpa cgo), React + TypeScript (UI, di-embed sebagai `web/dist` lewat `go:embed`).

---

## A. Peta arsitektur

Tiga proses:

1. **`cmd/factory-server`** — HTTP API + scheduler + SQLite store + UI ter-embed. Satu proses per deployment.
2. **`cmd/factory-worker`** — satu identitas pekerja tetap, satu runtime tetap (`codex` atau `claude-code`, tidak bisa diganti setelah registrasi pertama — `internal/controlplane/store.go:456-463`). Poll control plane, jalankan attempt.
3. **`factory-worker` (mode supervisor)** — proses anak yang dispawn ulang oleh worker sendiri (`cmd/factory-worker/main.go:18-24`, dideteksi lewat `IsSupervisorCommand`) untuk mengawasi satu proses agent (Codex CLI atau `claude` CLI) per attempt.

Alur satu task:

```
POST /api/v1/tasks (title, description, worker_id, repository_id, timeout)
  -> tasks + executions(state=queued) dibuat dalam satu transaksi (store.go:735-810)
worker poll -> POST /api/v1/workers/{id}/claims setiap ~2 detik + jitter
  -> Store.Claim (state.go:14-188) memilih execution FIFO, insert attempts(state=preparing),
     execution -> preparing
worker: git worktree baru di bawah data dir worker (git.go), tulis manifest lokal
  -> POST /api/v1/attempts/{id}/start -> attempts.state=running, executions.state=running
  -> spawn proses supervisor -> spawn `codex`/`claude` CLI di worktree
  -> event log (stdout/stderr) dikirim batch -> POST .../events
  -> heartbeat setiap 10 dtk -> PUT .../heartbeat (perpanjang lease)
  -> selesai -> POST .../complete (succeeded/failed/cancelled)
worktree: jika succeeded -> dibersihkan; jika tidak -> retained untuk inspeksi manual
```

Skema tabel inti (`migrations/001_controlplane.sql`, dengan evolusi di 002/004/006):

- `workers(id, name, worker_version, runtime, runtime_version, capacity, active_count, health, retained_worktrees_json, registered_at, last_heartbeat)`
- `repositories(id, remote_identity UNIQUE, created_at)` — deduplikasi lintas worker berdasar remote git identity
- `worker_repositories(worker_id, display_key, repository_id, retained_count, advertised, updated_at)` — repo mana yang diiklankan tiap worker, PK `(worker_id, display_key)`
- `tasks(id, request_key UNIQUE, title, description, repository_id, timeout_seconds, created_at)` — `request_key` adalah idempotency key
- `executions(id, task_id UNIQUE, assigned_worker_id, required_runtime, state, cancellation_requested, retry_count, created_at, updated_at)` — **satu task = satu execution** (UNIQUE di `task_id`), state machine: `queued -> preparing -> running -> {succeeded, failed, cancelled}`
- `attempts(id, execution_id, worker_id, attempt_number, state, lease_digest, lease_expires_at, supervisor_pid, process_identity, process_group_id, result, error, started_at, completed_at, created_at, capacity_acknowledged)` — bisa banyak attempt per execution (retry), tapi index unik `one_active_attempt_per_execution` (`001_controlplane.sql`) memastikan **hanya satu attempt aktif** per execution kapan pun
- `claim_requests(worker_id, request_id, lease_digest, attempt_id, created_at)` — idempotency untuk permintaan claim itu sendiri
- `attempt_events(attempt_id, sequence, kind, payload, payload_bytes, server_time)` — log terstruktur per attempt

Eksekusi agent: **tidak ada Docker/container sama sekali.** `grep -rn docker` di seluruh `internal/` dan `cmd/` kosong. Proses supervisor menjalankan `codex`/`claude` CLI **langsung di host worker**, di dalam git worktree yang dibuat khusus, dengan process-group tracking (`internal/worker/platform_unix.go`) supaya bisa dikill bersih. Isolasi = git worktree, bukan sandbox.

---

## B. Protokol worker

### B.1 Endpoint HTTP (kontrak lengkap)

Didaftarkan di `internal/controlplane/http.go:69-86`:

| Method/Path | Fungsi | Handler |
|---|---|---|
| `PUT /api/v1/workers/{worker_id}` | Registrasi (juga berfungsi sebagai heartbeat "aku hidup") | `http.go:163-200` -> `store.go:357` `RegisterWorker` |
| `POST /api/v1/workers/{worker_id}/claims` | Poll + klaim satu unit kerja | `http.go:202-221` -> `state.go:14` `Claim` |
| `GET /api/v1/workers`, `/{worker_id}` | Daftar/detail worker (UI) | `store.go:625,667` |
| `POST /api/v1/attempts/{attempt_id}/start` | Konfirmasi attempt mulai jalan (preparing->running) | `http.go:357-372` -> `state.go:289` `StartAttempt` |
| `PUT /api/v1/attempts/{attempt_id}/heartbeat` | Perpanjang lease attempt yang sedang jalan | `http.go:383-397` -> `state.go:332` `Heartbeat` |
| `POST /api/v1/attempts/{attempt_id}/events` | Kirim batch log/event (stdout/stderr agent) | `http.go:399-412` -> `state.go:356` `AppendEvents` |
| `GET /api/v1/attempts/{attempt_id}/events` | Baca log (dipakai UI polling) | `http.go:414-437` -> `state.go:447` `Events` |
| `POST /api/v1/attempts/{attempt_id}/complete` | Laporan selesai (terminal) | `http.go:485-500` -> `state.go:497` `CompleteAttempt` |
| `POST /api/v1/tasks/{task_id}/cancel` | Operator minta batal | `http.go:315-330` -> `state.go:567` `CancelTask` |
| `POST /api/v1/executions/{execution_id}/retry` | Operator retry execution gagal/batal | `http.go:332-346` -> `state.go:597` `RetryExecution` |

**Temuan kritis, bukan detail kecil:** kontrak ini secara desain **hanya untuk loopback**. Dua guard independen:

1. `internal/controlplane/server.go:18-48` `ResolveListenAddress` — menolak bind ke address yang bukan loopback (`127.0.0.1`/`::1`/`localhost` yang resolve ke loopback saja). Default listen `127.0.0.1:7337` (`cmd/factory-server/main.go:34`).
2. `internal/controlplane/http.go:519-537` `validateRequestHost`, dipanggil di setiap request lewat middleware `requestLog` (`http.go:132-136`) — menolak request apa pun (401→403 `invalid_host`) yang `Host` header-nya bukan loopback/localhost. Ini jalan bahkan kalau server dipaksa bind ke `0.0.0.0` lewat cara lain.

`ARCHITECTURE.md:64-65` mengonfirmasi ini bukan bug melainkan invarian arsitektur yang disengaja: *"The control plane and worker reject non-loopback server addresses because remote authentication and transport security are not implemented."* Dan `ARCHITECTURE.md` bagian keterbatasan: *"There is no authentication, authorization, tenant isolation, or remote worker transport."*

**Konsekuensi buat kebutuhan #2 kalian (worker di belakang NAT, mis. laptop rumah):** protokol poll/claim/lease *bentuknya* benar untuk itu — semua request memang outbound dari worker, tidak ada WebSocket, tidak ada koneksi masuk ke worker (`ARCHITECTURE.md:44-45`: *"Workers initiate every connection. The server does not connect to workers"*). Tapi implementasi saat ini **secara eksplisit memblokir** worker mana pun yang bukan di mesin yang sama dengan server, karena tidak ada auth/TLS untuk melindungi endpoint itu kalau dibuka ke jaringan. Ini bukan "belum sempat", tapi keputusan desain yang didokumentasikan sebagai known limitation. Untuk dipakai lintas mesin, dua guard ini harus dicabut dan digantikan dengan token/mTLS auth pada layer yang sekarang belum ada sama sekali.

### B.2 Leasing — bagaimana satu task jatuh ke tepat satu worker

Fungsi `Store.Claim` (`state.go:14-188`), satu transaksi SQLite (`_txlock=immediate` di DSN, `store.go:76` — artinya `BEGIN` langsung ambil write lock, bukan optimistic upgrade, jadi tidak ada race window antar-transaksi yang saling menunggu lalu gagal serentak).

Alur intinya:

1. Idempotency dulu: cek `claim_requests` untuk `(worker_id, request_id)` — kalau sudah pernah, kembalikan hasil yang sama (claim yang sama atau "kosong") tanpa memilih ulang (`state.go:34-73`). Ini melindungi dari retry jaringan double-claim.
2. Cek kelayakan worker: `healthy`, heartbeat dalam `WorkerOnlineWindow` (30 dtk), dan `active < capacity` (`state.go:75-102`).
3. **Query pemilihan pekerjaan** (`state.go:105-135`):

```sql
SELECT e.id
FROM executions e
JOIN tasks t ON t.id = e.task_id
JOIN worker_repositories wr
  ON wr.worker_id = e.assigned_worker_id AND wr.repository_id = t.repository_id
WHERE e.assigned_worker_id = ?
  AND e.required_runtime = ?
  AND e.state = 'queued'
  AND wr.advertised = 1
  AND wr.retained_count + (COUNT attempt aktif repo ini) + (COUNT attempt terminal belum diakui) < MaxRetainedPerRepo (10)
ORDER BY e.created_at, e.id
LIMIT 1
```

4. Insert `attempts(state='preparing', lease_digest=sha256(token), lease_expires_at=now+30s)`, lalu:

```sql
UPDATE executions SET state = 'preparing', ... WHERE id = ? AND state = 'queued'
```

dan **cek `RowsAffected() == 1`**, kalau tidak — `conflict("claim_conflict", ...)` (`state.go:166-176`). Ini pengaman kedua di atas SQLite write-lock: kalaupun dua transaksi entah bagaimana lolos, UPDATE bersyarat state lama ini yang jadi penentu akhir siapa menang.
5. Commit; simpan `claim_requests` row supaya replay idempotent.

**Apakah bebas race?** Ya, untuk definisi race "dua worker dapat attempt aktif yang sama": kombinasi `BEGIN` immediate-lock (serialize semua Claim di level SQLite, karena `db.SetMaxOpenConns(8)` tapi WAL + immediate lock membuat writer transactions serial secara efektif) + index unik `one_active_attempt_per_execution` (`migrations/001_controlplane.sql`, `WHERE state IN ('preparing','running')`) sebagai constraint DB-level terakhir. Index unik ini penting: bahkan kalau logika transaksi di atas punya bug, DB sendiri menolak insert kedua attempt aktif untuk execution yang sama. Ini pola defense-in-depth yang solid — bukan cuma "SELECT ... FOR UPDATE" ala aplikasi, tapi constraint fisik di skema.

Trade-off: karena SQLite dan `BEGIN immediate`, throughput klaim dibatasi jadi serial per database file. Untuk skala satu tim internal (puluhan task/menit) ini bukan masalah; untuk ribuan worker dia akan jadi bottleneck. Tidak relevan untuk kasus kalian.

### B.3 Heartbeat dan deteksi mati

Ada **dua heartbeat berbeda** dengan tujuan berbeda — penting untuk tidak disamakan:

**(i) Worker-level "aku online"** — bukan endpoint terpisah, melainik efek samping dari registrasi ulang periodik:
- `internal/worker/manager.go:23` `defaultRegistrationInterval = 10 * time.Second`, dipicu di `Run()` lewat `registrationTicker` (`manager.go:223,236-237`).
- `RegisterWorker` (`store.go:487-498`) melakukan `UPDATE ... last_heartbeat = excluded.last_heartbeat` di setiap panggilan PUT.
- "Online" didefinisikan di `scanWorker` (`store.go:710`): `now.Sub(worker.LastHeartbeat) <= protocol.WorkerOnlineWindow` — konstanta `WorkerOnlineWindow = 30 * time.Second` (`protocol/types.go:23`).
- Jadi: registrasi tiap 10 dtk, ambang offline 30 dtk → toleransi 2 kali gagal berturut-turut sebelum dianggap mati. Tidak ada endpoint heartbeat worker-level terpisah; registrasi itu sendiri *adalah* heartbeat-nya.
- **Efek worker hilang:** `Claim` menolak assign task baru ke worker yang `last_heartbeat` sudah lewat 30 dtk (`state.go:94`). Tapi status `Health`/`Online` di tabel `workers` **tidak otomatis diubah** — hanya dihitung on-read (`now.Sub(...)`, bukan kolom tersimpan). Tidak ada proses background yang menandai worker sebagai "dead" secara eksplisit.

**(ii) Attempt-level lease (per unit kerja yang sedang jalan)**:
- `protocol.LeaseDuration = 30 * time.Second` (`protocol/types.go:21`).
- Worker mem-perpanjang tiap `defaultLeaseRenewInterval = 10 * time.Second` (`manager.go:24`) lewat `PUT /attempts/{id}/heartbeat` — fungsi `heartbeatAttempt` (`attempt_lifecycle.go:235-279`), jalan di goroutine terpisah per attempt selama attempt aktif.
- Kalau gagal (network error) dia retry tiap `defaultLeaseRetryInterval = 2 * time.Second` (`manager.go:25`), tapi berhenti dan `handle.stop("lease_lost")` begitu `time.Now().After(handle.leaseExpiry())` (`attempt_lifecycle.go:273-276`) — worker sendiri yang menyerah begitu dia tahu lease-nya pasti sudah kedaluwarsa di server, tanpa perlu konfirmasi server.
- **Deteksi mati sisi server:** `Store.SweepExpired` (`state.go:633-687`), dijalankan oleh `RunSweeper` (`server.go:50-76`) tiap `sweepEvery = 5 * time.Second` (`store.go:83`) **dan sekali lagi saat startup server** (`cmd/factory-server/main.go:74-88`, sebelum HTTP listener dibuka — ini menutup celah "server restart lalu lease basi tidak pernah tersapu"). Query: `attempts WHERE state IN ('preparing','running') AND lease_expires_at <= now` → set `state='lost'`, `error='lease expired'`, dan execution terkait → `failed`.

**Bedakan "keluar bersih" vs "hilang mendadak":**
- *Keluar bersih* (task selesai normal, atau `ctx.Done()` saat worker shutdown lewat `SIGTERM`): `runAttempt` defer memanggil `handle.stopHeartbeat()` lalu `manager.complete(...)` (`attempt_lifecycle.go:44-50, 516-551`) yang mengirim `POST .../complete` sebelum proses keluar — state langsung `succeeded/failed/cancelled`, tidak menunggu sweeper.
- *Hilang mendadak* (proses worker crash, laptop mati, jaringan putus permanen): tidak ada `complete` yang terkirim. Attempt tetap `running` di DB sampai `lease_expires_at` lewat (maks 30 dtk sejak heartbeat terakhir sukses), lalu sweeper mengubahnya jadi `lost` dalam ≤5 dtk berikutnya. **Total window ketidakpastian: sampai ~35 detik** dari heartbeat terakhir sampai task ditandai `lost`+execution `failed`.
- Worker yang restart setelah crash punya **rekonsiliasi lokal** (`internal/worker/reconcile.go`) — baca manifest attempt tersimpan di data dir, cek proses lama (masih hidup? kill lewat process-group), verifikasi state attempt yang tersimpan sinkron dengan server (`reconcile.go:101-118` `verifyServerAttempt`), lalu putuskan worktree dibersihkan atau di-retain. Ini bagian yang cukup dalam — lihat E.

### B.4 Attempt dan retry

- Satu execution punya kolom `retry_count` (`migrations/006_execution_retries.sql`), naik tiap kali operator memanggil `POST /executions/{id}/retry`. **Retry adalah aksi manual operator**, bukan otomatis dari sistem — `RetryExecution` (`state.go:597-626`) hanya boleh dipanggil kalau state `failed`/`cancelled`, lalu `state -> 'queued'` lagi supaya masuk antrean klaim dari awal.
- Tiap retry membuat **attempt baru** dengan `attempt_number` naik (`state.go:154-156`, `MAX(attempt_number)+1`), bukan menimpa attempt lama — histori tiap percobaan tetap ada di tabel `attempts` (lihat `Task()` return semua `Attempts` terurut, `store.go:910-926`).
- **Tidak ada retry otomatis / max-attempt limit built-in.** `ARCHITECTURE.md` bagian keterbatasan menyebut eksplisit: *"There are no priorities, cron triggers, provider polling, or automatic retries."* Ini murni human-in-the-loop retry, tidak ada backoff policy atau attempt cap di server.
- Lease loss (`lost`) juga jadi execution `failed` (bukan otomatis `queued` lagi) — jadi worker mati di tengah attempt tidak memicu retry otomatis; operator harus klik retry.

### B.5 Ukuran sesungguhnya (baris kode)

Metodologi: saya hitung baris fungsi yang benar-benar terlibat di registrasi worker, leasing/claim, heartbeat (worker + attempt), dan polling — sisi server dan worker, termasuk HTTP client/handler plumbing-nya, tidak termasuk UI, metrics, cleanup filesystem, atau eksekusi agent (worktree/supervisor/manifest).

**Sisi control plane (`internal/controlplane`):**
| Bagian | File:baris | LOC |
|---|---|---|
| `Claim` (+ `insertEmptyClaim`, `claimDetail`, `loadLease`, `verifyActiveLease`) | `state.go:14-282` | ~284 |
| `StartAttempt`, `Heartbeat` | `state.go:289-354` | ~58 |
| `SweepExpired` (deteksi mati) | `state.go:628-687` | ~60 |
| `RegisterWorker` | `store.go:357-623` | ~267 |
| `Workers`/`Worker`/`scanWorker`/`workerRepositories` | `store.go:625-733` | ~109 |
| HTTP handlers (register/claim/list/get/start/heartbeat) | `http.go:163-239,357-397` | ~106 |
| `RunSweeper` loop | `server.go:50-76` | ~27 |
| **Subtotal server** | | **~911** |

**Sisi worker (`internal/worker`):**
| Bagian | File:baris | LOC |
|---|---|---|
| `claiming.go` (poll+claim orchestration, seluruh file) | `claiming.go:1-104` | 104 |
| `registration.go` (registrasi+efek heartbeat, seluruh file) | `registration.go:1-122` | 122 |
| `health.go` (prasyarat registrasi/eligibility, seluruh file) | `health.go:1-85` | 85 |
| `client.go` (HTTP client semua endpoint di atas, seluruh file) | `client.go:1-210` | 210 |
| `heartbeatAttempt` + helper terkait lease di attempt handle | `attempt_lifecycle.go:235-279,281-353` | ~65 |
| Loop ticker utama (`Run`) + jitter | `manager.go:197-245,311-320` | ~59 |
| **Subtotal worker** | | **~645** |

**Tipe protokol relevan** (`protocol/types.go`, subset field terkait leasing/registrasi dari 236 baris total): **~90**.

**Total protokol worker (registrasi + leasing + heartbeat + polling): ≈ 1.650 baris kode Go**, tersebar di 13 file. Tidak termasuk test (yang jauh lebih besar — `worker_integration_test.go` saja 1.706 baris, `store_test.go` 2.054 baris, mengindikasikan tim ini menguji protokol ini dengan sangat serius).

**Interpretasi buat kalian:** ~1.650 baris Go adalah inti logikanya — bukan kecil, tapi juga bukan besar untuk sebuah proyek "sedang" (2-4 minggu satu engineer termasuk test, kalau ditulis ulang di TypeScript dengan tingkat kehati-hatian yang sama). Poin pentingnya bukan jumlah barisnya, tapi **kepadatan keputusan desain per baris**: idempotency key ganda (claim_request + lease token), unique index sebagai constraint fisik terakhir, dua lapis heartbeat dengan window berbeda, replay-safe completion, dan guard startup-sweep-before-listen. Menulis ulang baris-baris itu gampang; menulis ulang *ketelitiannya* yang makan waktu.

---

## C. Skor terhadap sembilan kriteria

| # | Kriteria | Skor | Bukti |
|---|---|---|---|
| 1 | DAG fan-out, cabang beda mesin | **TIDAK ADA** | `ARCHITECTURE.md:377-378`: *"A task has one execution assigned to one worker. Fan-out and cross-worker rescheduling are not implemented."* Skema `executions.task_id` adalah `UNIQUE` (`migrations/001_controlplane.sql`) — satu task **tidak bisa** punya lebih dari satu execution aktif sekalipun secara skema. Dicari juga di `docs/workflows/design.md` (proposal reusable-prompt) — itu bukan DAG, hanya template prompt bernama+versi, tidak menyentuh graph/fan-out sama sekali (baca §D). |
| 2 | Worker terdaftar, outbound-only, NAT | **SEPARUH** | Bentuk protokolnya benar (poll/claim, worker selalu inisiasi — `ARCHITECTURE.md:44-45`), tapi implementasi **secara eksplisit memblokir** non-loopback di dua tempat (`server.go:18-48`, `http.go:519-537`), didokumentasikan sebagai keterbatasan sengaja (`ARCHITECTURE.md:64-65,` bagian §10: *"Only local loopback deployments are supported... no remote worker transport"*). Tidak bisa dipakai lintas mesin/NAT tanpa menambah auth layer dan mencabut guard ini. |
| 3 | Step nunggu manusia berjam-jam/hari, tahan restart | **SEPARUH** | Lease/attempt tahan restart control plane (sweep saat startup, `main.go:74-88`, tersimpan di SQLite bukan memori) dan tahan restart worker (`reconcile.go`). Tapi **tidak ada step yang secara desain "menunggu manusia"** — satu-satunya interaksi manusia adalah operator men-cancel atau me-retry seluruh task dari luar (`CancelTask`/`RetryExecution`), bukan sebuah *node* dalam alur yang berhenti menunggu input dan lanjut. Timeout task maksimum `MaxTimeout = 8 * time.Hour` (`protocol/types.go:20`) malah jadi batas atas eksplisit — bertentangan dengan "berdurasi hari". |
| 4 | Percakapan dua arah manusia di dalam step | **TIDAK ADA** | Dicari di `web/src/*.tsx` dan `internal/controlplane/http.go` — tidak ada endpoint kirim pesan ke attempt yang berjalan. `AppendEvents`/`Events` (`state.go:356,447`) satu arah: worker->server->UI, hanya log stdout/stderr agent (`TaskDetail.tsx:245-278`, render `event-list` read-only). `DelegateDrawer.tsx` (211 baris) hanya form buat task baru, bukan chat ke task berjalan. |
| 5 | Agent AI di sandbox Docker dgn repo checked-out | **SEPARUH** | Repo checked-out: ya, git worktree terisolasi per attempt (`internal/worker/git.go`, `attempt_lifecycle.go:63-69`). Sandbox Docker: **tidak ada** — `grep -rn docker` kosong di seluruh kode Go. Agent CLI (`codex`/`claude`) jalan langsung sebagai child process di host worker (`attempt_lifecycle.go:129-140` `startSupervisor`), isolasi cuma lewat working-directory + process-group, bukan container. |
| 6 | Artefak per step bisa diperiksa di UI | **SEPARUH** | Log event (stdout/stderr agent) dan `result`/`error` text bisa dilihat di UI (`TaskDetail.tsx`). Tidak ada "artifact" sebagai file/objek terpisah yang bisa didownload/dipreview (misal diff, screenshot, file hasil) — hanya teks log dan worktree yang di-retain di filesystem worker (tidak diekspos lewat UI, harus akses langsung ke mesin worker). |
| 7 | Editor visual -> definisi berbentuk kode | **TIDAK ADA** | Tidak ada di `web/src/*` — UI cuma dashboard (Overview/Work/Workers/TaskDetail) dan form delegasi single-task, bukan editor pipeline. `docs/workflows/design.md` (belum diimplementasi) juga hanya bicara TOML/text prompt, bukan graph visual. |
| 8 | Self-host penuh | **ADA** | Satu binary Go + SQLite lokal (`cmd/factory-server/main.go`), UI ter-embed (`web/embed.go`, `go:embed`), tanpa dependensi cloud. Ini kekuatan nyata kandidat ini. |
| 9 | Multi-user, peran, isolasi credential | **TIDAK ADA** | `ARCHITECTURE.md` §10 eksplisit: *"There is no authentication, authorization, tenant isolation..."* Tidak ada tabel `users`/`roles` di skema manapun (cek semua file `migrations/*.sql` — tidak ada). Satu operator = akses penuh ke semua task/worker/credential (credential berada di level runtime CLI tiap worker, mis. `claude auth status`, dicek di `health.go:51-75`, bukan dikelola per-user oleh control plane). |

**Ringkasan skor:** 1 ADA (self-host), 4 SEPARUH (worker protocol/NAT, human-wait/durability, sandbox+checkout, artefak UI), 4 TIDAK ADA (DAG, percakapan dua arah, editor visual, multi-user).

---

## D. Seberapa mahal menambahkan yang kurang

**Rancangan DAG:** dicari di `docs/`, `ARCHITECTURE.md`, git log, dan issue tracker (tidak bisa diakses offline, tapi tidak ada referensi issue di README/docs) — **tidak ada rancangan DAG sama sekali**, bahkan di level dokumen proposal. Tiga dokumen proposal yang ada (`docs/workflows/design.md`, `docs/github-ingest/design.md`, `docs/cli/design.md`) semuanya eksplisit *"does not change worker assignment, leases, attempts, worktrees, runtime selection, or cancellation"* (`docs/workflows/design.md:29-31`) — mereka sengaja dirancang untuk **tidak** menyentuh model eksekusi. "Workflow" di sini berarti *template prompt bernama+versi*, sama sekali bukan graph/pipeline. Klaim "workflow designed but not implemented" di README merujuk ke fitur ini, bukan DAG — istilah yang menyesatkan kalau dibaca sekilas.

**Apakah arsitektur menyambut DAG, human-in-the-loop, sandbox Docker, auth multi-user, atau ada yang menghalangi?**

Asumsi tertanam yang paling menghalangi, dengan lokasi persis:

1. **`executions.task_id UNIQUE`** (`migrations/001_controlplane.sql`) — satu task = satu execution secara *skema*, bukan cuma logika aplikasi. Menambah DAG/fan-out berarti migrasi skema besar: `executions` perlu jadi child dari sebuah `dag_run`/`step` baru, dan **setiap** query yang JOIN `tasks`-`executions` 1:1 (ada di ~15 tempat: `Task()`, `Tasks()`, `Claim()`, `CancelTask()`, `RetryExecution()`, `DeleteTask()`, dst di `store.go`/`state.go`) harus ditulis ulang. Ini bukan tambahan tabel di samping, ini bongkar tulang punggung.
2. **`worker_repositories` + capacity-per-repo accounting** (`store.go:105-135` query claim) mengasumsikan satu worker "memiliki" satu working copy per repo dengan `retained_count` yang di-track manual lewat mekanisme "capacity handoff" yang cukup rumit (`store.go:407-618`, ~200 baris logic disposal/acknowledgment). Fan-out ke banyak worker paralel pada repo yang sama akan langsung berbenturan dengan model retained-worktree-per-worker ini — didesain untuk 1 attempt aktif per (worker, repo) pada satu waktu secara implisit lewat `MaxRetainedPerRepo=10` sebagai *soft* cap, bukan concurrency yang direncanakan.
3. **Human-in-the-loop sebagai node**: tidak ada state `waiting_for_human` di CHECK constraint manapun (`state IN ('queued','preparing','running','succeeded','failed','cancelled')`, `001_controlplane.sql` & `004_worker_runtime.sql`). Menambah ini "hanya" butuh state baru + migrasi CHECK constraint (SQLite: rebuild tabel, pola ini sudah ada presedennya di `004_worker_runtime.sql` yang pakai teknik `-- factory: foreign-keys-off` rebuild) — ini bagian yang **paling murah** untuk ditambahkan, karena mereka sudah punya pola migrasi rebuild-tabel yang teruji.
4. **Docker sandbox**: paling murah secara struktural — `startSupervisor` (`attempt_lifecycle.go:129-140`) dan `supervisor.go` (1065 baris) mengabstraksi proses child lewat control-pipe protocol (fd 3) yang sudah generik; menukar `exec.Command` biasa dengan `docker run`/`docker exec` di titik itu adalah perubahan lokal, tidak menyebar ke skema DB. Tapi 1065 baris `supervisor.go` itu penuh asumsi proses-native-OS (`process_group_id`, `SIGTERM` process group, `platform_unix.go`) yang harus dipetakan ulang ke semantik container.
5. **Auth multi-user**: tidak ada apa pun untuk mulai dari — bukan "kurang lengkap", betul-betul nihil (tidak ada middleware auth, tidak ada tabel user, `validateRequestHost` cuma soal loopback bukan identitas). Ini proyek baru dari nol, terpisah dari kode yang ada.

**Kesimpulan D:** bagian yang menahan bukan "seberapa banyak baris kurang", tapi bahwa **`executions.task_id UNIQUE` dan model retained-worktree-per-worker menjadikan "satu task = satu agent run di satu worker" sebagai invarian skema**, bukan sekadar kebiasaan kode. DAG fan-out lintas worker butuh migrasi skema mayor + penulisan ulang mayoritas `state.go`/`store.go` (yang notabene sudah ~2000 baris test-nya sendiri) — ini bukan "tambah tabel", ini "ganti tulang punggung" sambil mempertahankan tulang punggung leasing yang sudah bagus.

---

## E. Yang tidak pernah masuk README — sudah dipecahkan?

- **Pemulihan setelah control plane restart**: **Sudah, dan cukup matang.** `main.go:74-88` menjalankan `SweepExpired` *sebelum* listener HTTP dibuka, jadi tidak ada window di mana request baru datang sementara lease basi belum tersapu. Ditambah SQLite WAL sebagai state store yang memang tahan restart (bukan in-memory).
- **Backpressure log**: **Sudah, eksplisit.** `protocol.MaxAttemptEventBytes = 10 << 20` (10 MiB per attempt, `protocol/types.go:16`), dicek di `AppendEvents` (`state.go:426-428`, mengembalikan `413 event_budget_exceeded` kalau lampaui) dan `MaxEventsPerBatch=100`/`MaxEventBatchBytes=256KiB` per panggilan. Bukan solusi elegan (klien harus tangani limit-reached sendiri), tapi ada batasnya, tidak akan membengkak tanpa henti.
- **Migrasi skema**: **Sudah, dan ini bagian paling matang dari codebase.** `store.go:184-236` `migrate()` + pola khusus `-- factory: foreign-keys-off` (`store.go:238-295`) untuk migrasi yang butuh rebuild tabel (SQLite tidak bisa ALTER CHECK constraint in-place) dengan verifikasi `PRAGMA foreign_key_check` pasca-migrasi. `migrations/002_attempt_capacity_handoff.sql` bahkan berisi *data migration* yang menolak upgrade kalau ada attempt aktif (`CHECK (active_count = 0)` sebagai guard, bukan cuma dokumentasi) — level kehati-hatian yang jarang terlihat di proyek sekecil ini.
- **Worker beda versi dengan server**: **Separuh.** Ada versioning eksplisit di level *registrasi* (`WorkerVersion`, `CapacityHandoffVersion` field di `protocol.WorkerRegistration` — `types.go:49-61`, dipakai untuk kompatibilitas mundur capacity-handoff logic, `store.go:552-558`). Tapi tidak ada negotiasi versi protokol HTTP itu sendiri (tidak ada `/api/v2/`, tidak ada header versi API) — kompatibilitas mundur ditangani lewat "legacy request" detection di body JSON (`http.go:171-198`, deteksi field `codex_version` vs `runtime`), yang berfungsi tapi rapuh untuk perubahan besar ke depan.
- **Cancel merambat ke worker yang sedang bekerja**: **Sudah, jalurnya jelas.** `CancelTask` set `executions.cancellation_requested=1` (`state.go:582-587`) tanpa langsung mengubah state attempt. Worker baru tahu lewat **respons heartbeat berikutnya** (`HeartbeatResponse.CancellationRequested`, dicek tiap 10 dtk di `heartbeatAttempt`, `attempt_lifecycle.go:261-264`) — begitu true, `handle.stop("cancelled")` mengirim sinyal ke supervisor untuk hentikan proses agent. **Latensi cancel: sampai ~10 detik** (interval heartbeat), bukan instan — trade-off yang wajar untuk model pull-based, tapi patut dicatat kalau kalian butuh cancel cepat.

---

## F. Vonis

### Kalau membangun di atas factory

**Tidak disarankan sebagai basis**, meski protokol worker-nya bagus, karena tiga alasan struktural yang saling memperkuat:

1. **Bahasa mismatch total**: 100% Go (server + worker + supervisor), kalian merencanakan TypeScript. "Membangun di atas" berarti kalian mewarisi runtime Go untuk dua dari tiga proses inti, atau menulis ulang keduanya di TypeScript sambil hanya "meniru" protokolnya — yang membuat pertanyaan "build vs buy" jadi tidak relevan lagi karena kalian menulis ulang toh.
2. **Loopback-only bukan konfigurasi, tapi invarian yang dijaga di dua tempat kode + didokumentasikan sebagai keputusan sengaja.** Mencabutnya butuh membangun auth/TLS layer dari nol (kriteria #9 kalian juga nihil di sini) — dua pekerjaan besar (network auth + multi-tenant auth) yang justru paling mahal untuk *ditambahkan*, bukan paling mahal untuk *ditulis dari awal* dengan desain yang tepat sejak hari pertama.
3. **`executions.task_id UNIQUE`** membuat DAG fan-out (kebutuhan #1, paling penting di daftar kalian) perlu migrasi skema mayor + rewrite besar `state.go`/`store.go`. Kalian akan menghabiskan waktu comparable dengan menulis leasing dari nol, ditambah waktu ekstra untuk memahami dan tidak merusak 2000+ baris test suite existing yang justru jadi alasan kepercayaan pada kode ini.

Kalau *tetap* mau pakai sebagai basis: cocok hanya kalau kalian menerima worker berjalan sebagai proses Go terpisah (bukan port ke TS) dan server tetap Go (bukan TS) — pada dasarnya membekukan stack ke Go untuk komponen ini walau UI/orkestrator lain di TS. Effort tambahan minimal: DAG (besar, ganti skema), human-in-the-loop step (sedang, state baru + migrasi rebuild-table pola yang sudah ada), Docker sandbox (sedang, titik integrasi sudah terisolasi di `startSupervisor`), auth multi-user (besar, dari nol), buka lintas-mesin (sedang-besar, cabut 2 guard + tambah token auth).

### Kalau membangun sendiri (TypeScript)

Pola konkret yang layak ditiru langsung, dengan lokasi:

1. **Kontrak worker minimal**: 8 endpoint di `http.go:69-86` adalah permukaan yang cukup — register (dobel jadi heartbeat), claim, start, heartbeat-attempt, events (append+read), complete. Jangan tambah endpoint lebih dari ini untuk MVP.
2. **Query leasing** `state.go:105-135` — pola "SELECT kandidat FIFO dengan subquery kapasitas, lalu UPDATE bersyarat `WHERE state='queued'` dan cek `RowsAffected==1`" adalah pola leasing minimal-tapi-benar yang portable ke Postgres langsung (ganti `BEGIN immediate` SQLite dengan `SELECT ... FOR UPDATE SKIP LOCKED` di Postgres — bahkan lebih baik untuk concurrency tinggi).
3. **Skema `attempts` terpisah dari `executions`** (`migrations/001_controlplane.sql`) — jangan gabung "unit kerja" dengan "percobaan ke-n unit kerja itu" dalam satu baris/state machine. Retry jadi baris baru, bukan reset state di tempat; histori otomatis lengkap.
4. **Index unik sebagai constraint fisik terakhir**: `one_active_attempt_per_execution ... WHERE state IN ('preparing','running')` — pola partial unique index ini portable ke Postgres (`CREATE UNIQUE INDEX ... WHERE state IN (...)`) dan seharusnya jadi baris pertama yang ditulis, bukan ditambah belakangan.
5. **Dua lease terpisah dengan window berbeda**: worker-level (`WorkerOnlineWindow=30s`, interval registrasi 10s) vs attempt-level (`LeaseDuration=30s`, interval renew 10s) — jangan disatukan; keduanya menjawab pertanyaan berbeda ("apakah worker ini bisa dikasih kerja baru" vs "apakah attempt spesifik ini masih hidup").
6. **Sweep dijalankan sekali saat startup sebelum listener dibuka, lalu berkala** (`main.go:74-88` + `server.go:50-76`) — cegah window di mana lease basi belum tersapu tapi API sudah menerima traffic.
7. **Idempotency dua lapis**: `claim_requests(worker_id, request_id)` untuk request klaim itu sendiri (`state.go:34-73`), dan `lease_digest = sha256(token)` sebagai bukti kepemilikan di setiap operasi lanjutan (start/heartbeat/events/complete, semua lewat `verifyActiveLease`, `state.go:274-282`) — token asli tidak pernah disimpan, hanya hash-nya dibandingkan.
8. **Cancel via poll, bukan push** (`HeartbeatResponse.CancellationRequested`) — kalau kalian butuh cancel <10 detik, ini titik yang perlu didesain beda dari factory sejak awal (SSE/WebSocket dari worker ke server untuk sinyal cancel, tapi itu melanggar prinsip "workers initiate every connection" yang justru bagus untuk NAT — trade-off yang harus dipilih sadar).

Yang **jangan** ditiru: model "satu worker = satu runtime tetap seumur hidup identitas" (`store.go:456-463`) — terlalu kaku untuk kebutuhan DAG multi-agent kalian; dan model retained-worktree-capacity-handoff (`store.go:407-618`, ~200 baris) — kompleksitasnya besar untuk manfaat sempit (hanya soal disk space worktree), redesain lebih sederhana kemungkinan cukup untuk kasus kalian.
