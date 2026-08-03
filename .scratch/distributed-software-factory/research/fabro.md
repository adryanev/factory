# Fabro — Analisis Build-vs-Buy

Repo: `/private/tmp/claude-501/.../scratchpad/repos/fabro` (clone lokal, HEAD `5eb36d1`, 12 jam sebelum riset ini, MIT, Copyright Qlty Software Inc.)
Semua path di bawah relatif terhadap root repo. Semua klaim disertai `path:baris`; kalau saya menulis "tidak ditemukan", itu artinya saya sudah grep dan tidak dapat hasil — dicatat di mana saya mencari.

---

## A. Peta arsitektur

Fabro adalah workspace Cargo dengan ~30 crate, dibagi tiga lapis:

- `lib/foundation/*` — primitif: `fabro-core` (state machine graph-agnostic: `Executor`, `Handler` trait, `Graph` trait — `lib/foundation/fabro-core/src/executor.rs`, `graph.rs`), `fabro-db` (SQLite index/summary), `fabro-auth`, `fabro-types`.
- `lib/components/*` — domain: `fabro-workflow` (mesin workflow konkret — implementasi `Graph`/`Node`/`Edge` di atas `fabro-graphviz`), `fabro-sandbox` (provider abstraction), `fabro-interview` (protokol tanya-jawab manusia), `fabro-store` (event log + blob store), `fabro-checkpoint` (checkpoint via git commit), `fabro-github`.
- `lib/apps/*` — proses: `fabro-server` (HTTP API, axum), `fabro-cli` (juga jadi *worker process* lewat subcommand tersembunyi `__run-worker`), `fabro-spa` (SPA React di-embed sebagai binary asset — **source JS/TS SPA tidak ada di checkout ini**, hanya placeholder `assets/.gitkeep`, jadi saya tidak bisa memeriksa langsung apakah UI punya editor visual).

**Alur satu run, dari trigger sampai selesai:**

1. Trigger (API call, webhook, cron di `automation_triggers`) → server menulis event `RunCreated` ke event log run tsb (lihat §state di bawah) dan baris ke tabel `runs` (`lib/foundation/fabro-db/migrations/2026071104_runs.sql:1-50`, status awal `submitted`/`pending`).
2. Server **spawn subprocess** `fabro-cli __run-worker` via `tokio::process::Command` — **ini "worker"**: proses child di mesin yang sama dengan server, bukan proses yang mendaftar dari jarak jauh (`lib/apps/fabro-server/src/worker_runtime.rs:80-112`). Server memberi child sebuah JWT bertipe `Principal::Worker { run_id }` (`lib/apps/fabro-server/src/worker_token.rs:103-132`, `lib/foundation/fabro-types/src/principal.rs:20-22`).
3. Worker menjalankan `fabro-core::Executor` yang men-traverse graph node demi node lewat `Handler` trait (`lib/foundation/fabro-core/src/executor.rs`). Tiap `Node` datang dari parsing file `.fabro` (Graphviz DOT + atribut kustom) oleh `fabro-graphviz` (`lib/components/fabro-graphviz/src/parser/`).
4. Tiap node dieksekusi lewat handler sesuai `shape`/`type`: `agent`/`llm` (memanggil coding agent di sandbox), `human` (gate, lihat §C.2/D), `parallel` (fan-out — lihat §C.1), `command`, `conditional`, `wait`, dst. (`lib/components/fabro-workflow/src/handler/*.rs`).
5. Sandbox dibuat lewat `SandboxProvider` (§C.1) — checkout repo, jalankan agent, tangkap diff.
6. Tiap transisi/hasil ditulis sebagai event append-only (lihat §state).
7. Selesai → event `RunSucceeded`/`RunFailed`, baris `runs.status` diupdate via projeksi.

**Di mana state disimpan — dua lapis, bukan satu:**

- **Source of truth**: event log append-only per run, disimpan di `object_store` (blob store — default `LocalFileSystem`, opsional S3, `lib/apps/fabro-server/src/serve.rs:22-24,397`), dengan key berpola `runs/{run_id}/events/{seq:06}-{epoch_ms}` (`lib/components/fabro-store/src/keys.rs:58-81`). Ini murni event sourcing: state run direkonstruksi dari event, bukan dibaca langsung dari kolom SQL.
- **Index/summary**: SQLite (`sqlx`, `sqlite-bundled`) — tabel `runs` (`lib/foundation/fabro-db/migrations/2026071104_runs.sql`) untuk listing/filtering cepat (status, token usage, diff stats), plus `automations`, `automation_triggers`, `secrets`, `variables`, `environments`, `mcp_servers` di migration terpisah (`lib/foundation/fabro-db/migrations/*.sql`).
- **Checkpoint**: bukan baris DB — commit git di branch/ref khusus dalam sandbox repo, ditulis lewat `git2`/libgit2 (`lib/components/fabro-checkpoint/src/git.rs:161-190`).

**Bagaimana agent benar-benar dieksekusi:** handler `llm`/`agent` (`lib/components/fabro-workflow/src/handler/llm/`) memanggil sandbox (`Sandbox` trait, `lib/components/fabro-sandbox/src/sandbox.rs`) untuk `exec_command`/`spawn_stdio_process` di dalam container/proses. Untuk provider `local`, ini secara harfiah `tokio::process::Command::new("bash").arg("-c")...` di host yang sama (`lib/components/fabro-sandbox/src/local.rs:454-469`). Untuk `docker`, `bollard` container `exec` di daemon Docker lokal.

---

## B. Skor terhadap sembilan kriteria

| # | Kriteria | Status | Bukti |
|---|---|---|---|
| 1 | DAG fan-out, cabang beda mesin | **SEPARUH** | Fan-out DAG jelas ada dan bagus (`for_each`/edge ganda, konkurensi dibatasi semaphore): `lib/components/fabro-workflow/src/handler/parallel.rs:358-364,415-586`. Tapi **semua cabang jalan sebagai `tokio::spawn` task di proses worker yang sama**, berbagi satu `Sandbox` instance (lihat `graph = Arc::clone(&shared_graph)` lalu tiap branch pakai sandbox yang sama lewat `services.run` — tidak ada dispatch antar-mesin). Tidak ada mekanisme kirim satu cabang ke worker lain. |
| 2 | Worker terdaftar, outbound-only, NAT-friendly | **TIDAK ADA** | "Worker" = subprocess lokal yang di-`spawn()` oleh server sendiri (`lib/apps/fabro-server/src/worker_runtime.rs:17-22,116-144` — trait `WorkerRuntime` hanya punya satu implementasi, `LocalWorkerRuntime`, identitasnya `WorkerRef::Local { pid: u32 }`). Tidak ada endpoint registrasi worker, tidak ada worker yang "menarik" pekerjaan dari server, tidak ada worker yang bisa hidup di mesin lain apalagi di belakang NAT. Dicari: `struct Worker`, `worker registration`, `poll for work` — nihil di seluruh `lib/`. |
| 3 | Step tunggu manusia, jam/hari, tahan restart | **SEPARUH → lebih ke TIDAK ADA untuk restart** | Human gate ADA dan didesain baik untuk *long-running block* (`lib/components/fabro-workflow/src/handler/human.rs:187-435`, blocking via `Interviewer` trait + event `run.blocked`/`run.unblocked`). Tapi **tidak tahan restart control-plane**: lihat §C.2/D — saat server restart, run berstatus `Blocked` (termasuk human gate) di-**fail**, bukan di-resume otomatis (`lib/apps/fabro-server/src/server.rs:3060-3105`). |
| 4 | Percakapan dua arah dengan manusia (bukan approve/reject) | **ADA** | `fabro-interview` crate: `Question`/`Answer` dengan tipe `MultipleChoice`, `YesNo`, `Freeform`, `MultiSelect` (dipakai di `lib/components/fabro-workflow/src/handler/human.rs:460-475`); ada juga `control.rs`, `control_protocol.rs`, `queue.rs` untuk sesi interaktif berkelanjutan (`lib/components/fabro-interview/src/control.rs`, `queue.rs`). Ini bukan sekadar tombol approve/reject — mendukung teks bebas dan multi-select. |
| 5 | AI coding agent di sandbox Docker dengan repo checkout | **ADA** | `SandboxProvider::Docker` variant lengkap (`lib/components/fabro-sandbox/src/docker.rs`, 2726 baris), termasuk clone repo ke dalam container (`clone_origin_url`/`clone_branch` di `docker.rs:136-235`), image default `buildpack-deps:noble` (`docker.rs:100-120`). |
| 6 | Artefak per step bisa diperiksa (diff, transkrip, JSON, dst) | **ADA** | Event-sourced log per stage + blob offload otomatis untuk payload >100KB dengan referensi `blob://sha256/...` (`lib/components/fabro-workflow/src/artifact.rs:19-51`); `ParallelBranchResult` per cabang tersimpan terstruktur; `command_log.rs`, `checkpoint.rs` (diff), `event/events.rs` untuk transkrip. |
| 7 | Editor visual → kode (visual-to-code) | **TIDAK ADA (sejauh yang bisa diverifikasi)** | Workflow ditulis sebagai file `.fabro` = Graphviz DOT tangan (lihat contoh nyata `.fabro/workflows/smoke/workflow.fabro:1-23` — DOT murni dengan atribut kustom seperti `script=`, `goal_gate=`). Tidak ada library graph-editor (react-flow/dagre/xyflow) di dependency SPA — **tapi source JS SPA tidak ada di checkout ini** (`lib/apps/fabro-spa/assets/` cuma `.gitkeep`, dibangun terpisah lalu di-embed lewat `rust-embed`, `lib/apps/fabro-spa/src/lib.rs:1-48`), jadi klaim ini berdasarkan tidak-adanya evidence, bukan bukti negatif yang pasti. `fabro-cli render_graph` cuma me-render DOT→SVG, bukan editor. |
| 8 | Self-host penuh, tanpa layanan berbayar wajib | **ADA** | SQLite bundled (`sqlite-bundled` feature, root `Cargo.toml:16`), blob store default `LocalFileSystem` (`lib/apps/fabro-server/src/serve.rs:397`), sandbox provider `local`/`docker` adalah default feature (`lib/components/fabro-sandbox/Cargo.toml:10-13` — `default = ["local"]`), **Daytona (cloud sandbox berbayar) adalah Cargo feature opsional**, tidak wajib untuk compile/jalan. GitHub App dipakai untuk auth+git, tapi lihat §E soal self-hosted git. |
| 9 | Multi-user dengan peran & isolasi credential | **TIDAK ADA** | Lihat detail di §C.2 — tidak ada tabel `users`, tidak ada `owner_id`/`user_id` di tabel manapun, `secrets`/`variables` adalah namespace global per-nama (`lib/foundation/fabro-db/migrations/2026071101_secrets.sql:1-2`, `2026063001_variables.sql:1-2`), auth = daftar `allowed_usernames` GitHub di `settings.toml` (`lib/foundation/fabro-types/src/settings/server.rs:110`). |

---

## C. Dua pertanyaan penentu

### C.1 — Bisakah sandbox berjalan di host lain?

**Trait provider:** `SandboxProvider` (`lib/components/fabro-sandbox/src/provider.rs:46-54`) — cukup sempit: `list/get/create/delete`, tidak ada konsep lokasi/host/afinitas mesin dalam signature-nya. Secara teori ini *seam* yang bisa diimplementasi ulang.

**Tapi implementasi konkretnya semua terikat ke mesin yang sama dengan proses yang memanggilnya:**

- `local`: `LocalSandbox::exec_command` langsung `tokio::process::Command::new(self.bash()?)` di host lokal (`lib/components/fabro-sandbox/src/local.rs:454-469`). Tidak ada abstraksi jaringan sama sekali.
- `docker`: `Docker::connect_with_local_defaults()` — **hardcoded ke socket Docker lokal**, tidak ada opsi `DOCKER_HOST` remote di `DockerSandboxOptions` (`lib/components/fabro-sandbox/src/docker.rs:169`, struct opsi di `docker.rs:100-115` cuma punya `image`, `network_mode`, `memory_limit`, `cpu_quota`, `auto_pull`, `env_vars`, `skip_clone` — tidak ada `host`/`endpoint`). Satu-satunya pemakaian `connect_with_http` adalah di test dengan mock server (`docker.rs:2388`), bukan jalur produksi.
- `daytona`: ini satu-satunya provider yang *memang* remote (API cloud Daytona) — tapi itu SaaS berbayar, bukan "worker milik kita di rumah".

**Filesystem-sharing:** worker (proses yang memanggil sandbox) adalah subprocess dari server itu sendiri (`lib/apps/fabro-server/src/worker_runtime.rs:80-112`, `WorkerRef::Local { pid: u32 }`) — jadi seluruh rantai *server → worker subprocess → sandbox local/docker* berjalan di **satu mesin**. Tidak ada kode yang berasumsi eksplisit tentang shared filesystem karena tidak pernah ada percobaan memisahkannya — semuanya memang satu proses/host tanpa lapisan jaringan di antaranya.

**Fan-out juga di dalam satu proses:** tiap cabang `parallel` adalah `tokio::spawn` di worker yang sama, berbagi satu instance sandbox (`lib/components/fabro-workflow/src/handler/parallel.rs:400-435` — `branch_services` di-clone tapi sandbox datang dari `services.run`, tidak per-cabang).

**Seberapa dalam kalau mau tambah provider "remote worker menarik kerja":**
Ini **bukan** "tinggal satu trait baru". Yang perlu dibongkar:
1. `WorkerRuntime` trait cuma punya satu varian (`Local`) dan model "server spawn subprocess" (`worker_runtime.rs:17-22`) — untuk worker yang menarik kerja lewat outbound connection, seluruh model start/stop/is_alive perlu diganti jadi pull-based (long-poll/websocket), bukan lagi `Command::spawn()`.
2. Trait `SandboxProvider` sendiri OK sebagai seam, tapi implementasi Docker perlu parametrized endpoint (bukan `connect_with_local_defaults()`), dan perlu cara membawa hasil (diff, log, artifact) balik ke server lewat jaringan, bukan baca file lokal.
3. Fan-out (`ParallelHandler`) perlu didesain ulang total supaya tiap cabang bisa dikirim ke worker berbeda — sekarang assumption "satu sandbox per node run" tertanam di `run_branches` (`parallel.rs:326-733`).
4. Auth worker (`WorkerTokenKeys`, `lib/apps/fabro-server/src/worker_token.rs`) sudah pakai JWT scoped per-run — ini bagian yang **bisa dipakai ulang** untuk auth worker remote.

**Kesimpulan C.1:** Ini bukan pembongkaran arsitektur inti (event log, graph engine tetap valid), tapi **pembongkaran besar di lapisan eksekusi**: worker-spawning, sandbox provider konkret, dan fan-out — tiga komponen yang saat ini semua mengasumsikan "satu proses, satu host".

### C.2 — Seberapa dalam asumsi single-tenant?

**Tidak ada tabel `users` di skema manapun.** Dicari lewat `CREATE TABLE` di semua migration (`lib/foundation/fabro-db/migrations/*.sql`, `lib/foundation/fabro-config/migrations/*.rs`, `lib/apps/fabro-server/migrations/*.rs`) — hanya ada `runs`, `automations`, `automation_triggers`, `secrets`, `variables`, `environments`, `mcp_servers`. Tidak satupun punya kolom `owner_id`/`user_id`/`created_by`.

**Identitas** direpresentasikan lewat enum `Principal` (bukan tabel DB) — `User`, `Worker`, `Webhook`, `Slack`, `Agent`, `System` (`lib/foundation/fabro-types/src/principal.rs:18-43`). `UserPrincipal` cuma bawa `identity` (issuer+subject dari GitHub OIDC), `login`, `auth_method` — ini **diverifikasi saat request masuk**, tidak pernah disimpan sebagai baris database. Otorisasi = keanggotaan di `allowed_usernames: Vec<String>` yang dibaca dari `settings.toml` saat startup (`lib/foundation/fabro-types/src/settings/server.rs:110`, dipakai di `lib/foundation/fabro-config/src/resolve/server.rs:170-180`).

**Credential store** (`secrets` table) adalah **namespace global keyed by name**, bukan per-user: `PRIMARY KEY (name)` (`lib/foundation/fabro-db/migrations/2026071101_secrets.sql:1-2`). Siapapun yang authenticated (masuk `allowed_usernames`) melihat & memakai kredensial yang sama — tidak ada baris "secret ini milik user X".

**`runs` table** (`lib/foundation/fabro-db/migrations/2026071104_runs.sql:1-50`) tidak punya kolom pemilik sama sekali — hanya `parent_id` (untuk fork/retry lineage), tidak ada `triggered_by`/`owner`. (Principal yang memicu run kemungkinan ada di *event* `RunCreated`, bukan di tabel summary — tapi itu tetap bukan kolom yang bisa di-JOIN atau diberi RLS.)

**Kesimpulan C.2:** Ini **bukan** "tambahan kecil". Tidak ada primitif kepemilikan di level manapun — DB, event, atau tipe. Menambah peran + isolasi credential per-user berarti:
1. Skema baru: tabel `users`, kolom `owner_id` di `runs`/`automations`, dan **migrasi ulang total tabel `secrets`/`variables`** dari `PRIMARY KEY(name)` global jadi `PRIMARY KEY(owner_id, name)` atau setara — perubahan skema yang breaking, bukan penambahan.
2. Model otorisasi berbasis daftar-nama-di-config harus diganti total jadi role-based check yang query DB, disisipkan di setiap handler yang baca `secrets`/`variables`/`runs`.
3. `Principal` enum sudah cukup baik sebagai basis identitas (bisa dipertahankan), tapi setiap titik yang saat ini mengasumsikan "semua user melihat semua data" (list runs, list secrets, dst.) perlu filter kepemilikan ditambahkan satu-per-satu.

Ini pembongkaran skema + lapisan otorisasi, bukan modifikasi cepat.

---

## D. Yang tidak pernah masuk README

- **Semantik retry**: ADA dan cukup matang — per-node `RetryPolicy` dengan backoff presets (`none/standard/aggressive/linear/patient`), exponential backoff dengan jitter (`lib/components/fabro-workflow/src/retry.rs:6-69`). Retry dihormati juga di jalur paralel (`parallel.rs:492-533`).
- **Pemulihan state setelah control-plane restart, khususnya human gate yang menggantung**: **TIDAK diselesaikan dengan baik**. Fungsi `reconcile_incomplete_runs_on_startup` (`lib/apps/fabro-server/src/server.rs:3071-3105`) berjalan setiap kali server start, dan **men-fail semua run yang statusnya `Starting`, `Running`, `Blocked`, `Paused`, atau `Removing`** (`should_reconcile_run_on_startup`, `server.rs:3060-3069`) — dengan pesan "Fabro server restarted before the run reached a terminal state." Perilaku identik juga terjadi saat **graceful shutdown** (`persist_shutdown_run_failures`, `server.rs:3122-3151`). Artinya **step human-gate yang sedang menunggu jawaban manusia berjam-jam/berhari-hari akan di-fail, bukan dilanjutkan**, kalau server perlu di-restart (deploy, crash, dsb). Ada operasi `resume` terpisah (`lib/components/fabro-workflow/src/operations/resume.rs:11-50`) yang **bisa** membangunkan ulang run dari checkpoint event log — tapi ini manual (dipanggil eksplisit lewat API/CLI), bukan otomatis saat server boot.
- **Backpressure saat log membanjir**: dicari kata kunci "backpressure" di seluruh `lib/` — **tidak ditemukan satupun hit**. Tidak ada mekanisme bounded-channel/rate-limit eksplisit yang saya temukan untuk output command yang sangat besar; `drain_command_pipe` di local sandbox membaca ke buffer di memori tanpa batas atas yang terlihat (`lib/components/fabro-sandbox/src/local.rs:990-1017`).
- **Migrasi skema database**: pakai `sqlx` migration standar (fitur `migrate` di `Cargo.toml:16`), file `.sql` bernomor timestamp (`lib/foundation/fabro-db/migrations/2026*.sql`) plus migrasi custom berbasis kode Rust untuk data lama (`lib/foundation/fabro-config/migrations/*.rs`, `lib/apps/fabro-server/migrations/*.rs`) — pola forward-only standar, tidak ada yang eksotis.
- **Penanganan versi berbeda antar komponen** (server vs worker vs CLI): dicari `protocol_version`, `schema_version`, `CompatVersion`, `version_mismatch` di `fabro-store`, `fabro-workflow`, `fabro-cli` — **tidak ditemukan**. Karena worker = subprocess yang di-spawn dari binary `fabro-cli` yang sama dengan server (bukan proses independen yang bisa punya versi beda), ini "diselesaikan" dengan cara menghindar dari masalahnya — bukan karena ada negosiasi versi eksplisit.
- **Cancel yang merambat ke step berjalan**: ADA dan jalurnya jelas. `CancellationToken` dialirkan lewat `EngineServices` sampai ke level exec command; di `parallel.rs` tiap fan-out branch memeriksa token sebelum ambil slot (`parallel.rs:762-775`) dan `acquire_branch_permit`/`backoff_or_cancel` keduanya `select!` terhadap cancel; di sandbox lokal, `token.cancelled()` memicu `sigterm_then_kill(&mut child)` yang benar-benar mengirim SIGTERM lalu SIGKILL ke process group (`lib/components/fabro-sandbox/src/local.rs:492-499,966-988`). Ini implementasi cancel yang solid sampai ke OS process level.

---

## E. Pertanyaan tambahan

**Editor visual → DOT, atau DOT ditulis tangan?** Bukti kuat menunjuk ke: **DOT ditulis tangan** (atau oleh agent AI sebagai teks). Contoh nyata di repo sendiri: `.fabro/workflows/smoke/workflow.fabro:1-23` adalah file DOT biasa dengan atribut kustom (`script=`, `goal_gate=`, `shape=Mdiamond`). Tidak ada dependency graph-editor (react-flow/dagre/xyflow/d3) di manapun yang bisa saya periksa — **tapi catatan penting**: source JavaScript/TypeScript untuk `fabro-spa` (SPA web) **tidak ada di checkout ini**; direktori `assets/` cuma `.gitkeep`, dan crate `fabro-spa` cuma meng-embed hasil build lewat `rust-embed` (`lib/apps/fabro-spa/src/lib.rs:1-48`, ada test yang butuh `cargo dev spa refresh`). Jadi saya **tidak bisa 100% memastikan** UI-nya cuma papan monitoring — tapi tidak ada bukti sebaliknya, dan `fabro-cli render_graph` yang saya temukan hanya render DOT→SVG satu arah.

**Seberapa terikat ke GitHub?** Sangat terikat. `GITHUB_API_BASE_URL: &str = "https://api.github.com"` hardcoded (`lib/components/fabro-github/src/lib.rs:12`). Auth server pakai GitHub App OAuth (`lib/apps/fabro-server/src/web_auth.rs`, `jwt_auth.rs`). Saya cari indikasi dukungan Gitea/Forgejo/git host self-hosted lain (`rtk grep` untuk "gitea"/"forgejo"/git host abstraction) — **tidak ditemukan** di `lib/components/fabro-github` maupun tempat lain. `git2` (libgit2) dipakai untuk operasi git generik (clone/commit/push) di sandbox dan checkpoint, jadi *sandbox-side git ops* itu host-agnostic — tapi PR creation, webhook, App-auth, semuanya API GitHub.com khusus. Kesimpulan: git generik OK, tapi **hosting platform (PR, webhook, auth) terkunci ke GitHub.com**, tidak ada abstraksi provider seperti pada sandbox.

**Bagaimana human gate & interview disimpan supaya tahan restart?** Pertanyaannya agak menyesatkan berdasarkan bukti di §D: **tidak benar-benar tahan restart secara otomatis**. Yang ADA: state interview di-checkpoint ke event log (`InterviewStarted`/`InterviewCompleted`/`InterviewInterrupted` events, terlihat dipakai di `handler/human.rs:253-360`), jadi *history*-nya persisten dan **bisa** dipakai untuk `resume` manual. Tapi begitu server mati dan restart, run yang lagi nunggu jawaban manusia di-fail otomatis oleh `reconcile_incomplete_runs_on_startup` — manusia harus tahu untuk memanggil `resume` secara eksplisit, sistem tidak melanjutkan sendiri.

**Kesehatan proyek:** commit terakhir `5eb36d1`, 12 jam sebelum riset ini, oleh Bryan Helmkamp (pendiri Code Climate/Qlty) — merge PR #690, aktif dikembangkan. **Lisensi: MIT** sungguhan, `LICENSE.md` di root, "Copyright Qlty Software Inc." — konsisten dengan `license.workspace = true` = `"MIT"` di `Cargo.toml:16`.

---

## F. Vonis

### Kalau membangun di atas Fabro

**Ukuran perubahan: pembongkaran besar**, bukan penambahan, untuk 2 dari 9 kebutuhan inti (#1 fan-out lintas mesin, #2 worker terdaftar NAT-friendly), dan pembongkaran skema+auth untuk #9 (multi-tenant). Tiga hal ini — eksekusi terdistribusi, worker pull-based, dan multi-tenancy — adalah **jantung dari apa yang mau dibangun**, dan ketiganya butuh membongkar asumsi arsitektur inti Fabro (satu proses/host, satu namespace credential global).

**Konsekuensi bahasa**: Fabro 100% Rust, workspace besar dan dalam (engine di `fabro-core`, tipe di `fabro-types`, dst. saling bergantung erat lewat trait). Kalau stack yang direncanakan TypeScript, "membangun di atas Fabro" berarti salah satu dari:
- Menjalankan Fabro sebagai proses terpisah dan mengontrolnya lewat API-nya (server axum sudah expose REST) — tapi ini tidak membuka celah untuk mengubah model eksekusi/worker/tenancy dari luar, karena itu semua logic internal Rust yang tidak exposed sebagai extension point.
- Fork dan modifikasi Rust langsung — berarti tim harus kompeten Rust untuk memelihara perubahan besar di executor, sandbox provider, dan skema, selamanya. Ini bukan keputusan build-vs-buy lagi, tapi build-in-Rust-instead-of-TypeScript.

Kombinasi (pembongkaran besar di 3 area inti) + (bahasa asing dari stack yang direncanakan) membuat "build on Fabro" secara efektif setara dengan menulis ulang bagian yang paling sulit sambil menanggung beban maintenance codebase Rust besar yang tidak dikuasai tim.

### Kalau membangun sendiri — pola yang layak ditiru

1. **Event sourcing untuk run state**: log append-only per run di object storage (`runs/{id}/events/{seq}-{ts}`), state adalah proyeksi, bukan sumber — `lib/components/fabro-store/src/keys.rs:54-92`. Pola ini memberi resume-from-checkpoint gratis (kalau dipakai secara otomatis, bukan manual seperti di Fabro) dan artifact history yang inspektable.
2. **Checkpoint sebagai git commit**, bukan baris DB — `lib/components/fabro-checkpoint/src/git.rs:161-190`. Diff jadi artefak asli yang bisa di-`git show`, bukan blob JSON custom.
3. **Graph engine generik lewat trait** (`Graph`/`Node`/`Edge`/`Handler` di `fabro-core`, diimplementasikan konkret di `fabro-workflow`) — pemisahan bersih antara "cara traverse DAG dengan retry/goal-gate" dan "apa arti tiap node type". Layak ditiru strukturnya meskipun bahasa beda.
4. **Sandbox trait sempit** (`list/get/create/delete` + `exec_command`/`spawn_stdio_process`/file ops, `lib/components/fabro-sandbox/src/provider.rs:46-54` & `sandbox.rs`) — interface-nya sendiri bagus dan layak dicontoh; yang harus **dihindari** adalah kesalahan Fabro: implementasi konkretnya (local/docker) diam-diam mengasumsikan "sama host dengan pemanggil". Kalau tim mendesain ulang, pastikan dari hari pertama sandbox execution dan worker location adalah dua concern terpisah — jangan biarkan `docker.rs` connect ke socket lokal secara hardcoded seperti Fabro (`docker.rs:169`).
5. **JWT scoped per-run untuk worker auth** (`lib/apps/fabro-server/src/worker_token.rs:14-18,103-132`) — pola token dengan `run_id` + `scope` claim, TTL pendek (72 jam), key derivation terpisah dari user JWT. Bisa dipakai ulang langsung untuk worker remote yang narik kerja, asal ditambah mekanisme long-poll/pull.
6. **Cancel propagation via `CancellationToken`** turun sampai proses OS — `select!` di setiap titik tunggu (semaphore, backoff, exec) plus `sigterm_then_kill` dua-tahap (`local.rs:492-499,966-988`). Pola sinyal-lalu-timeout-lalu-kill ini solid dan layak ditiru persis.

**Jangan tiru**: model "worker = subprocess yang di-spawn server" (tidak bisa jadi laptop di belakang NAT — butuh redesain total ke pull-based dari awal), dan model auth "daftar username di config file + namespace credential global" (tidak scalable ke multi-tenant, harus didesain dengan tabel `users`+`owner_id` sejak skema pertama, bukan ditambah belakangan).
