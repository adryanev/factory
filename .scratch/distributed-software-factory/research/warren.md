# Warren — Analisis Source untuk Keputusan Build-vs-Buy

**Repo:** github.com/jayminwest/warren · **License:** MIT (Copyright 2026 Jaymin West) · **Commit HEAD saat analisis:** `bfaa11e` — "test(diagnostics): make the bwrap probe tests platform-hermetic", 2026-07-30 21:42 -0700 (kemarin, sangat aktif). Stack: TypeScript/Bun, Drizzle ORM (SQLite + Postgres), React+Vite UI.

Catatan metodologi: seluruh temuan di bawah dibaca dari source code, bukan README/docs — docs dikutip hanya untuk konfirmasi silang atau saat source tidak menjawab (lihat C4).

---

## A. Peta Arsitektur

**Komponen utama** (`src/`):
- `server/` — HTTP API (Bun), router + handlers, auth, SSE event streaming.
- `runs/` — domain inti: spawn, steer, cancel, watchdog, reap (post-run pipeline), stream/bridge, cost tracking.
- `plan-runs/` — coordinator untuk menjalankan satu seed-issue per satu waktu secara berurutan (lihat C-bawah, bukan DAG).
- `runtime/` — seam `RuntimeProvider` + dua implementasi: `local/` (wrap `burrow`, sandbox bwrap) dan `k8s/` (satu pod per run).
- `burrow-client/` — facade tipis di atas package eksternal `@os-eco/burrow-cli`.
- `db/` — Drizzle schema (sqlite + postgres paralel) dan repos.
- `registry/builtins/` — definisi agent bawaan (claude-code, pi, codex/sapling) sebagai objek TS dengan `system` prompt + frontmatter, bukan template visual.
- `ui/` — React SPA: daftar runs, run detail, plan-runs, cost analytics — tidak ada DAG/pipeline editor (lihat B7).
- `preview/`, `triggers/`, `healer/`, `ci-fixer/`, `supervisor/` — fitur pendukung (preview env per-run, cron scheduler, auto-healer, CI-fix loop, host-side git identity/token manager).

**Alur satu run, dispatch → PR** (`src/runs/spawn/dispatch.ts:1-40`, `src/runtime/local/provider.ts:132-148`, `src/runs/reap/pipeline.ts`):
1. Operator/trigger memanggil `spawnRun`. Warren membuat row `runs` dulu (id di tangan, `burrowId`/`burrowRunId` masih null) — SEBELUM memanggil provider.
2. `provider.create(spec)` dipanggil dengan `RunSpec` netral (tanpa detail backend). `LocalProvider.create` melakukan `burrowsUp` (provision workspace via git worktree + bwrap) lalu `runs.create` (dispatch agent) — dua call burrow digabung jadi satu method seam (`src/runtime/local/provider.ts:113-148`).
3. Event stream burrow (NDJSON) di-tail oleh bridge (`src/runs/stream/bridge.ts`), di-normalisasi ke `NormalizedEvent`, disimpan ke tabel `events`, dan cost/token diekstrak in-stream (lihat C3).
4. Watchdog (`src/runs/watchdog.ts:1-40`) memantau heartbeat; run yang diam >45 menit (default) di-force-fail.
5. Saat run terminal, `reapRun` jalan: `provider.finalize(handle, intent)` menjalankan bagian reap yang menyentuh workspace (merge `.mulch`/`.seeds`/`.plans`, commit bookkeeping, `git push`) DI TEMPAT workspace berada (host-side untuk LocalProvider, in-pod untuk K8s) dan mengembalikan delta terstruktur (`src/runtime/contract.ts:263-330`).
6. Jika ada commit baru, `runPrOpen` (`src/runs/reap/pr-open.ts`) membuka PR via GitHub API dengan retry (3x, backoff 1s/2s/4s, hanya untuk error transient — 422 "no commits between" tidak di-retry).
7. `provider.terminate(handle)` menghancurkan sandbox + arsip.

**Skema Drizzle** (`src/db/schema/sqlite.ts`, paralel di `postgres.ts`, drift dicek `drift.test.ts`): `agents` (registry cache), `projects`, `runs` (state machine + cost/token columns + salvage columns), `events` (write-through cache stream burrow), `triggers` (cron bookkeeping), `plan_runs` + `plan_run_children` (coordinator sekuensial), `run_inbox` (steering channel K8s). Tabel `workers`/`burrows` (multi-worker placement) dan `conversations`/`messages`/`plot` **sudah dihapus** — lihat C1/E.

**Bagaimana agent dieksekusi:** Warren sendiri **tidak** mengeksekusi agent langsung. Untuk `local` runtime, ia mengirim HTTP request ke package eksternal `@os-eco/burrow-cli` (`package.json:90`, versi pin `^0.3.15`) yang co-tenant dalam container yang sama via unix socket — burrow-lah yang mem-fork bwrap dan menjalankan agent CLI (claude-code/pi/codex). Untuk `k8s` runtime, Warren membangun `V1Pod` murni (`src/runtime/k8s/pod-spec.ts:1-24`) dengan init-container untuk clone repo, lalu agent CLI berjalan langsung sebagai container pod itu (bukan lewat burrow sama sekali) dengan `securityContext` hardened (`runAsNonRoot`, `capabilities.drop:[ALL]`, dst).

---

## B. Skor terhadap Sembilan Kriteria

| # | Kriteria | Skor | Bukti |
|---|---|---|---|
| 1 | DAG dengan fan-out, cabang beda mesin | **TIDAK ADA** | `advancePlanRun` (`src/plan-runs/coordinator.ts:167-375`) adalah loop sekuensial: `pickNextPending` (`src/db/repos/plan-runs.ts:371-386`) query `ORDER BY seq ASC LIMIT 1` — satu child dieksekusi, tunggu PR-nya merge, baru lanjut child berikutnya. Tidak ada concept fan-out/fan-in atau graph sama sekali; ini queue linear di atas daftar seed-issue. |
| 2 | Worker terdaftar (Docker/host), outbound-only, di belakang NAT | **TIDAK ADA** | Konsep `workers`/multi-burrow placement **pernah ada** lalu dihapus: `src/burrow-client/local.ts:1-24` — "The multi-worker `BurrowClientPool` (pool.ts), fan-out (fanout.ts), and placement (`src/runs/placement.ts`) layers were retired... warren's self-host backend is exactly ONE local burrow." Backend `k8s` juga bukan model pull-worker — control plane langsung membuat `V1Pod` via Kubernetes API (push model, perlu akses cluster API, bukan outbound-only dari belakang NAT). |
| 3 | Step tunggu manusia berjam/berhari, tahan restart | **TIDAK ADA** | State `paused` dan kolom `paused_at`/`paused_question_event_id` **sudah dihapus** secara eksplisit: migrasi `src/db/migrations/drop-run-pause-columns.test.ts:1-8` — "The pause detector (`src/runs/pause.ts`) and the `paused` run state were retired with the Plot deletion pass... nothing ever wrote these columns." Mode run sekarang hanya `["batch"]` (`src/core/wire.ts:64`) — mode `interactive`/`conversation` "intentionally dropped from the enum" (warren-d622, warren-ee27). Tidak ada primitive tunggu-manusia yang durable. |
| 4 | Percakapan dua arah manusia-di-dalam-step | **TIDAK ADA** (lihat C2) | Steer (`POST /runs/:id/steer`) adalah injeksi satu arah non-blocking ke inbox agent, bukan percakapan. Tidak ada mekanisme agent "bertanya lalu menunggu" jawaban. |
| 5 | AI coding agent di sandbox Docker dengan repo checked-out | **SEPARUH** | Untuk `k8s` runtime: ya, satu pod = satu container OCI per run, repo di-clone oleh init-container (`src/runtime/k8s/pod-spec.ts:16-19`). Untuk `local` runtime (topologi default self-host): isolasi bukan Docker per-run, tapi bwrap (namespace-level) di dalam SATU container Warren+burrow bersama (`README.md:94,245`). Docker dipakai untuk deploy image keseluruhan, bukan sebagai unit sandbox per-run pada mode default. |
| 6 | Artefak per step, bisa diperiksa di UI | **SEPARUH** | UI run-detail menampilkan event log, cost/token, PR link. Tapi "artifact" di codebase (`grep -rn artifact`) hanya merujuk ke `FinalizeResult.artifacts` — delta bookkeeping (`mulch`/`seeds`/`plans` merge), bukan artefak arbitrer per-step (build output, file hasil test, dsb) yang bisa di-preview di UI. Tidak ditemukan artifact store generik. |
| 7 | Editor visual → definisi berbentuk kode | **TIDAK ADA** | UI hanya berisi halaman CRUD/monitoring (`src/ui/src/pages/*.tsx`: Runs, RunDetail, PlanRuns, Agents, Projects, CostAnalytics, Login) — dicari tapi tidak ditemukan direktori/komponen flow-editor, canvas, atau node-graph apa pun. Definisi agent (`AgentDefinition`) ditulis sebagai objek TS statis di `registry/builtins/*.ts` (mis. `claude-code.ts:32-51`), bukan dihasilkan dari editor visual. |
| 8 | Self-host penuh | **ADA** | `docker-compose.yml`, `Dockerfile`, single-container topology "one container, one volume, warren and burrow together" (`README.md:106-107`), SQLite default tanpa dependensi eksternal (`src/db/client.ts`). |
| 9 | Multi-user dengan role + isolasi credential | **TIDAK ADA** | `src/server/auth.ts:1-30` eksplisit: "V1 posture is single-user... one bearer token from `WARREN_API_TOKEN`". Satu `Actor` dengan full capabilities untuk siapa pun yang punya token; provider `public` hanya menambah level anonymous read-only, bukan multi-user. `ROADMAP.md`: multi-user (GitHub App, per-token scope) berstatus **`next`**, belum dibangun. |

---

## C. Empat Hal Paling Layak Dipelajari

### C1. Runtime provider yang bisa ditukar — `RuntimeProvider` contract

File: `src/runtime/contract.ts` (508 baris, types-only), diimplementasi oleh `src/runtime/local/provider.ts` dan `src/runtime/k8s/provider.ts`, diseleksi lewat registry `src/runtime/registry.ts:140-174` via env `WARREN_RUNTIME` (`local` default, `k8s` opt-in, nilai lain → error keras, tidak pernah fallback diam-diam).

Interface-nya delapan method (`src/runtime/contract.ts:445-508`):
```
create(spec) → RunHandle
streamEvents(handle, opts?) → AsyncIterable<NormalizedEvent>
status(handle) → RunStatus            // NEVER throws; exists:false untuk run hilang
sendMessage(handle, msg) → Message
cancel(handle, reason?) → void
workspaceInfo(handle) → WorkspaceInfo // host path | null
finalize(handle, intent) → FinalizeResult   // seam paling berat, lihat bawah
terminate(handle) → TeardownResult
```
`RunHandle` sengaja opaque (`runId` domain + `sandboxId`/`providerRunId` milik provider) — domain dilarang membaca bentuk id itu (`src/runtime/contract.ts:16-28`). `RuntimeCapabilities` (`contract.ts:198-222`: `previewPorts`, `networkPolicy`, `longLived`, `midRunSteering`, `enforcedResourceLimits`, `workspaceArchive`, `workspaceGc`) adalah mekanisme degradasi eksplisit — domain **bercabang** pada boolean ini, bukan berasumsi (contoh nyata di C2).

Bagian paling instruktif adalah `finalize()` — bukan desain awal, tapi hasil dari masalah nyata yang didokumentasikan di `docs/design/runtime-provider-contract.md:191-246`: reap lama membaca `.seeds`/`.mulch`/git worktree langsung dari disk host. Di bawah pod-per-run, control-plane dan pod tidak berbagi filesystem. Opsi yang **ditolak eksplisit** adalah `exec(handle, argv)` remote-exec ("breaks on pod/warren restart... drags host-path and git-exec semantics back across the seam"). Solusi yang diambil: jalankan bagian reap yang menyentuh workspace **di tempat workspace itu berada** (host-side untuk LocalProvider, in-pod exit-hook untuk K8s), dan kembalikan delta terstruktur (`FinalizeResult.artifacts`, `dirtyPaths`, `stages: FinalizeStageOutcome[]`) yang domain terapkan ke clone-nya sendiri.

**Nilai untuk model "remote worker":** kontrak ini cukup lentur untuk backend baru — tidak ada tipe burrow/pod yang bocor ke domain, semua field `RunSpec` adalah intent netral (`network: "none"|"restricted"|"open"`, bukan `SandboxProfile`). Provider ketiga ("remote worker yang pull") secara struktural bisa diimplementasikan tanpa mengubah `src/runs/*`. TAPI: kontrak ini diam-diam mengasumsikan provider bisa **langsung membuat kerja dan menunggu hasilnya secara sinkron/streaming** (`create()` returns cepat, lalu `streamEvents` di-pull segera oleh warren). Model outbound-only/pull-based (worker menarik job) butuh inversi arah — provider tidak akan bisa "push create ke sandbox", melainkan domain perlu antre job dan worker yang poll. `finalize()` sudah menunjuk arah yang benar (workspace-dependent logic dijalankan di sisi eksekusi, hasil dikembalikan sebagai delta) — pola yang sama bisa dipakai untuk queue: `create()` menaruh job di antrean, bukan memanggil provider secara langsung. Tapi kontrak SEKARANG tidak punya primitive antre/klaim job untuk `create`/`cancel`/`status` — hanya `sendMessage` (steer) yang sudah punya pola queue-and-poll (lihat C2), yang justru merupakan cetak biru paling dekat untuk model worker outbound-only.

### C2. Mekanisme steer — injeksi satu arah, BUKAN percakapan blocking

`POST /runs/:id/steer` → `steerRun` (`src/runs/steer.ts:65-111`) → `provider.sendMessage(handle, msg)`. Implementasi dua backend berbeda drastis dan ini kuncinya:

- **LocalProvider (burrow, `midRunSteering: true`, `src/runtime/local/provider.ts:95`):** pesan dikirim ke inbox burrow yang **scoped per-burrow** (bukan per-run) via `POST /burrows/:id/inbox`. Menurut komentar module (`src/runs/steer.ts:1-9`): "delivered to the next agent turn on the same burrow." Untuk agent `pi`, ini live via stdin-RPC (disebut di kontrak `contract.ts:203`: "conversation / holdStdin streaming"), jadi bisa nyaris mid-turn.
- **K8sProvider (`midRunSteering: false`, `src/runtime/k8s/provider.ts:160-172`):** tidak ada socket live ke pod. Pesan dipersist ke tabel `run_inbox` (`src/db/repos/run-inbox.ts:1-27`), lalu in-pod agent harness **poll** `GET /runs/:id/inbox` setiap ~5 detik (komentar: "folded in at the next poll, not delivered mid-turn"). Endpoint poll (`src/runs/inbox.ts:1-50`) meng-klaim SEMUA row `unread` dalam SATU `UPDATE...RETURNING` atomik (`src/db/repos/run-inbox.ts:122-132`) — race-safe, tapi eksplisit **at-most-once**: "a message claimed then lost to a pod crash is not redelivered; steering is a best-effort nudge, not durable RPC" (`src/runs/inbox.ts:16-18`).

Jawaban langsung untuk pertanyaan tim: **agent tidak pernah menunggu manusia**. Ini murni fire-and-forget — server menaruh pesan, giliran agen berikutnya (baik mid-turn stdin atau next-poll) yang "melihatnya" kalau kebetulan sedang membaca inbox. Tidak ada state run yang menandakan "menunggu balasan operator" (state `paused` sudah dihapus, lihat B3). Priority (`low/normal/high/urgent`) dan FIFO-by-seq (`src/db/repos/run-inbox.ts:52-58,143-147`) hanya mengatur urutan pengiriman, bukan urutan tunggu.

**Bisakah dikembangkan jadi percakapan dua arah blocking?** Secara teknis bisa dipakai sebagai fondasi setengah jalan — pola queue-and-poll K8s (`run_inbox` + atomic claim) adalah primitive yang tepat untuk komunikasi durable, restart-safe. Yang HARUS ditambahkan: (a) state run baru yang benar-benar block dan tahan restart (persis yang mereka hapus di B3 — kemungkinan karena implementasi lama-nya kompleks/rapuh, bukan karena idenya salah), (b) agent-side harus mampu emit "pertanyaan" sebagai event terstruktur dan berhenti, bukan hanya membaca inbox pasif di sela giliran. Kesimpulan: **Warren pernah mencoba ke arah ini** (mode `conversation`/`interactive`, kolom `paused_*`) **dan mundur** — sinyal kuat bahwa human-in-the-loop blocking yang genuine sulit dibangun di atas model "batch run yang di-poll", bukan sekadar belum sempat dikerjakan.

### C3. Cost & token tracking — dipanen dari output CLI agent, bukan dihitung ulang

Dua jalur (`src/runs/stream/stats.ts:1-13`):
1. **In-stream extraction (utama, `src/runs/usage-aggregate.ts`)** — bridge mem-parsing payload event JSON yang SUDAH dikirim agent CLI ke stdout-nya sendiri, verbatim tanpa modifikasi (kontrak mewajibkan payload lossless, `contract.ts:103,309`):
   - **claude-code:** envelope terminal tunggal `{"type":"result","total_cost_usd":N,"usage":{...}}` — Warren cuma membaca field ini (`extractClaudeUsage`, `usage-aggregate.ts:139-162`). Cost/token berasal dari perhitungan internal claude-code CLI sendiri (yang pada gilirannya dari Anthropic API usage), Warren TIDAK menghitung dari harga model manual.
   - **pi:** akumulasi per-turn dari envelope `turn_end`, dengan catatan penting: field `message_end` sengaja DIABAIKAN karena double-count (`usage-aggregate.ts:80-84`), hanya `turn_end.message.usage.cost.total` yang dijumlah.
2. **Out-of-band RPC (`persistPiStatsDelta`, `src/runs/spawn/... stats.ts:48-114`)** — untuk kasus wire format tidak membawa usage (custom dispatcher), Warren memanggil RPC `get_session_stats` milik pi lalu ambil delta (terminal − baseline) karena sesi pi bisa `--continue` dari state sebelumnya (angka RPC selalu kumulatif-sesi).

Semua write ke kolom `runs.cost_usd`/`tokens_*` bersifat **best-effort** — gagal di-log dan diabaikan (never fail the run). Read-time fallback (`aggregateUsageFromEvents`, `usage-aggregate.ts:175-185`) me-reconstruct total dari tabel `events` jika bridge mati sebelum checkpoint terakhir (mis. restart control plane) — pola durability yang solid, layak ditiru: source-of-truth tetap event log, kolom agregat cuma cache yang bisa dihitung ulang kapan saja.

**Kesimpulan untuk map kami:** tidak ada API biaya independen (tidak query Anthropic billing API, tidak hardcode $/token per model). Sepenuhnya bergantung pada agent CLI yang jujur melaporkan usage-nya sendiri di stdout. Batasan: kalau agent CLI-nya sendiri tidak melaporkan cost (model baru, provider baru), kolom cost tetap `null` — tidak ada fallback berbasis token-counting independen.

### C4. Isolasi sandbox Bubblewrap — TIDAK terlihat dari repo ini

Temuan paling penting untuk C4: **implementasi bwrap sesungguhnya TIDAK ada di repo Warren.** `src/burrow-client/` hanya facade tipis di atas package npm eksternal `@os-eco/burrow-cli` (`package.json:90`, versi `^0.3.15`) — repo terpisah di `github.com/jayminwest/burrow` (disebut eksplisit di `README.md:75`), oleh author yang sama. `node_modules` tidak ter-install di clone ini sehingga source burrow-cli sendiri tidak terbaca. Yang bisa dikonfirmasi HANYA dari sisi klien:

- Warren mem-probe kesehatan bwrap host lewat `checkBwrap` (`src/diagnostics/checks-sandbox.ts:63-105`) dengan argv aktual (`bwrapProbeArgv`, baris 36-48):
  ```
  bwrap --unshare-all --share-net --ro-bind / / --die-with-parent -- /bin/true
  ```
  Ini probe FUNGSIONAL (bukan cuma `--version`) karena `--version` bisa pass di host yang user-namespace-nya di-disable AppArmor/sysctl — kegagalan nyata baru muncul saat bwrap benar-benar mencoba membuat sandbox. Linux-only; di macOS/lainnya check ini di-skip (burrow pakai `sandbox-exec` di macOS, kata komentar).
- README (`README.md:94,245`) menyatakan klaim tanpa bukti source langsung di repo ini: "every run gets a fresh `bwrap`-isolated workspace... host is unreachable... talks over unix socket with shared bearer token." Network default `open` (unshared network namespace TIDAK dipakai — `--share-net` di probe di atas mengonfirmasi jaringan host TETAP dipakai, hanya filesystem yang diisolasi via `--ro-bind`/mount namespace).
- Jaminan yang **eksplisit tidak ada**: tidak ada cgroup CPU/memory limit yang terlihat dari sisi Warren untuk `local` runtime (kontrak menyebut `enforcedResourceLimits: true` untuk LocalProvider di `local/provider.ts:96`, tapi mekanismenya — cgroup v2 via burrow — tidak terverifikasi dari source ini).

**Rekomendasi jujur:** untuk menjawab "apa yang dijamin dan tidak dijamin" secara definitif, repo `burrow` itu sendiri perlu dibaca terpisah — di luar scope tugas ini (tim eksplisit meminta baca source Warren). Yang bisa disimpulkan dari sisi Warren: model isolasinya adalah **bwrap process-namespace sandboxing di dalam satu container bersama**, BUKAN container-per-run pada topologi default — kontras dengan K8s runtime yang memakai isolasi pod/OCI penuh + kubelet cgroup enforcement asli (`pod-spec.ts:12-19`). Baris README: "the pod boundary is the sandbox instead (kubelet-enforced CPU and memory, no bwrap)" — mengonfirmasi bwrap hanya dipakai di topologi single-box.

---

## D. Yang Tidak Pernah Masuk README

- **Semantik retry.** Tidak generik/framework-level. Ditemukan per-kasus: PR-open GitHub API di-retry 3x dengan backoff eksponensial 1s/2s/4s, hanya untuk error transien yang diklasifikasi eksplisit (`isRetryablePrResult`, `src/runs/reap/pr-open.ts:19-40`) — 422 "no commits between" sengaja TIDAK di-retry (permanent). Dispatch agent sendiri TIDAK di-retry — kegagalan create/dispatch langsung fail run (`src/runs/spawn/dispatch.ts` komentar: "anything before create just throws"). Tidak ada retry umum untuk transient network error di level provider (`burrow-client/client.ts:1-30`: "No retry/backoff loop... warren's run lifecycle wants explicit failure not hidden retry. Add at the call site if needed").
- **Pemulihan setelah restart control plane.** Ditangani lewat `bootBridges`/`bridge-reconnect.ts` — setiap run `running` dengan `burrowId` tersimpan di-reattach stream-nya saat boot; run yang backend-nya sudah tidak punya record (ghost) direkonsiliasi ke `failed` via `reconcileLostBurrowRun` (`src/server/bridge-reconnect.ts:1-30`). Karena state persist penuh di DB (bukan in-memory), restart tidak kehilangan run — tapi CATATAN penting: primitive "pause tahan-restart untuk step tunggu manusia" justru yang **dihapus** (lihat B3), jadi recovery yang ada hanya untuk run yang sedang berjalan, bukan run yang sedang menunggu manusia.
- **Backpressure log membanjir.** Ada cap eksplisit di level koneksi SSE, bukan di level volume event: `WARREN_MAX_EVENT_STREAMS` (default 200 instance-wide) dan `WARREN_MAX_EVENT_STREAMS_PER_CLIENT` (default 5) — penolakan cepat HTTP 503 + `Retry-After`, bukan buffering (`src/server/stream-limits.ts:1-45`). Tidak ditemukan rate-limiting pada VOLUME event per detik dari satu agent (mis. agent yang spam stdout) — payload diteruskan lossless apa adanya sesuai kontrak (`contract.ts:103`), jadi backpressure murni ada di level jumlah koneksi viewer, bukan throughput writer.
- **Migrasi skema Drizzle.** Konvensional: file SQL bernomor sekuensial (`0000`...`0035`) per dialect, dijalankan via `drizzle-orm/bun-sqlite/migrator` / `node-postgres/migrator` saat boot (`src/db/client.ts:19-31,151-154`). Ada quirk didokumentasikan: SQLite butuh FK dimatikan sementara migrasi jalan untuk mendukung pola "12-step ALTER" (SQLite tidak native ALTER COLUMN). Drift antara schema SQLite dan Postgres dicek test khusus (`src/db/schema/drift.test.ts`). Beberapa migrasi eksplisit men-drop kolom/tabel mati (pause columns, placement tables, plot tables, conversations tables) — codebase secara aktif membersihkan state lama, bukan cuma menambah.
- **Cancel yang merambat.** `cancelRun` (`src/runs/cancel.ts:1-45`) sengaja TIDAK langsung transisi state run — ia memanggil `provider.cancel()` (graceful, best-effort) lalu membaca `provider.status()` out-of-band; hanya kalau status sudah terminal barulah `reapRun` dipanggil inline. Alasan didokumentasikan eksplisit: kalau `cancelRun` finalize row langsung, reap akan skip sub-step (mulch merge, seeds-close, branch push) via short-circuit `isTerminal`-nya sendiri, sehingga partial work agent bisa hilang. Watchdog timeout memakai jalur yang SAMA (bukan jalur terpisah) — "same philosophy as cancelRun" (`watchdog.ts:22-27`).
- **Penanganan kegagalan runtime.** Signal `oom_killed` dan `evicted` (K8s: kubelet eviction karena ephemeral-storage habis) dipromosikan jadi `TerminalReason` first-class di kontrak (`contract.ts:130-156`) — komentar mengaku burrow SUDAH punya sinyal OOM sejak lama tapi Warren dulu MEMBUANGNYA ("warren currently discards it"), baru di-unify saat migrasi K8s. Ada mekanisme "salvage-before-destroy" (`docs/design/runtime-provider-contract.md:248-272`, warren-cd3b) untuk kasus finalize gagal push: workspace di-capture jadi rescue-branch (`warren/rescue/<runId>`) DAN git-bundle lokal sebelum sandbox dihancurkan — supaya kegagalan infra tidak menghapus commit agent yang belum ter-push.

---

## E. Vonis

### Kalau membangun DI ATAS Warren

Yang harus ditambahkan, dan besarnya:

1. **DAG dengan fan-out** — BESAR, dan berlawanan arah dengan arsitektur yang ada. `plan-runs/coordinator.ts` adalah state machine linear yang dirancang keras untuk "satu child, tunggu merge, lanjut" (`IN_FLIGHT_STATES`, `pickNextPending LIMIT 1`). Menambah fan-out paralel + percabangan-ke-mesin-beda berarti menulis ulang coordinator dari nol, bukan mengembangkan yang ada — child-state machine-nya tidak punya slot untuk "jalankan N child bersamaan" atau "tunggu semua sebelum lanjut" (join). Kalaupun ditulis ulang, seam `RuntimeProvider` di bawahnya tetap bisa dipakai apa adanya per-node.
2. **Worker terdaftar, outbound-only, di belakang NAT** — BESAR. Model ini SECARA SENGAJA dihapus dari codebase (multi-worker pool, fanout, placement — semua "retired"). Model yang ada sekarang cuma dua: (a) satu box lokal, atau (b) K8s control-plane yang PUSH pod langsung ke API server cluster (butuh network akses ke API server, bukan pull dari belakang NAT). Membangun model pull-based worker berarti provider ketiga yang arahnya berlawanan dari asumsi `create()` sinkron saat ini — bukan mustahil (pola queue di `run_inbox`/C2 bisa jadi cetak biru), tapi ini pekerjaan desain baru, bukan ekstensi.
3. **Step tunggu-manusia durable berjam/berhari** — BESAR, dan riwayatnya justru MUNDUR. State `paused`, kolom `paused_at`, mode run `interactive`/`conversation` — semua PERNAH ADA dan DIHAPUS. Ini bukan lubang yang belum diisi; ini fitur yang dicoba lalu dibongkar. Sinyal kuat bahwa arsitektur `batch`-run-yang-di-poll milik Warren membuat state tunggu-manusia yang tahan-restart itu sulit dipertahankan/mahal di-maintain — worth digali kenapa (kemungkinan besar: state itu tidak fit ke model tabel `runs` yang linear-lifecycle).
4. **Auth multi-user + role + isolasi credential** — BESAR. Sekarang single bearer-token, satu `Actor` dengan full capability. Tim sendiri sudah menandai ini "next" (GitHub App campaign), belum ada satu baris implementasi role/scope di luar `readPublic`/`readOperator`/`dispatch`/`admin` empat boolean flat yang semuanya true/false bersamaan untuk operator (`src/server/auth.ts:53-60`).

**Apakah arsitekturnya menyambut, atau ada asumsi "satu run = satu agent, satu mesin" tertanam?** Tertanam DALAM — bukan cuma di provider (yang sudah didesain abstrak dengan baik lewat `RuntimeProvider`), tapi di layer atasnya: tabel `runs` adalah satu row = satu agent = satu lifecycle linear = satu workspace. Tidak ada konsep "run" yang terdiri dari banyak node graph. `plan_run_children` adalah satu-satunya bentuk "banyak run terkait", dan itu didesain SEKUENSIAL by design (tunggu merge). Bagian yang justru SANGAT well-separated dan layak dipakai langsung: seam `RuntimeProvider` (C1) — itu murni "bagaimana SATU run dieksekusi di SATU backend", ortogonal terhadap orkestrasi di atasnya. Kalau membangun di atas Warren, `src/runtime/contract.ts` bisa diadopsi hampir verbatim sebagai model abstraksi sandbox kami (poin kebutuhan #5); tapi `plan-runs/` harus ditulis ulang total untuk DAG, dan `auth.ts` + skema `runs` perlu perluasan besar untuk multi-user + orkestrasi graph.

### Kalau membangun sendiri

Pola konkret yang layak ditiru, dengan lokasi:

1. **`RuntimeProvider` seam (`src/runtime/contract.ts`)** — desain kontrak paling matang di repo ini, hasil dari migrasi nyata (burrow → K8s) yang dituliskan alasan tiap keputusannya di `docs/design/runtime-provider-contract.md`. Terutama: (a) opaque `RunHandle`, (b) `RuntimeCapabilities` sebagai mekanisme degradasi eksplisit alih-alih polymorphism diam-diam, (c) `finalize()` sebagai jawaban untuk "workspace-touching logic yang mesti jalan dekat data" — pola ini langsung relevan untuk kebutuhan kami poin #5 (agent sandbox) dan #1 (step lintas mesin: logika finalize-di-tempat adalah jawaban untuk masalah yang SAMA yang akan kami hadapi kalau step DAG kami pindah mesin).
2. **Pola `run_inbox` queue-claim (`src/db/repos/run-inbox.ts:79-147`, `src/runs/inbox.ts`)** — single atomic `UPDATE...WHERE state='unread' RETURNING`, priority-desc lalu FIFO-by-seq in-app. Ini pola paling dekat dengan kebutuhan #3/#4 kami (human-in-the-loop durable) — TAPI Warren memakainya untuk fire-and-forget injection, bukan blocking wait. Kode klaimnya (atomicity, crash-safety, priority ranking `PRIORITY_RANK`) bisa dipinjam langsung (sama-sama TS/Drizzle) untuk primitive "inbox pesan operator ↔ agent"; yang perlu KAMI tambahkan sendiri adalah pasangannya: state run yang benar-benar block menunggu balasan, bukan sekadar disuntik di sela giliran.
3. **`usage-aggregate.ts` shape-sniffing + read-time reconstruction (`src/runs/usage-aggregate.ts:175-209`)** — pola solid untuk cost tracking: ekstraksi in-stream sebagai jalur cepat (checkpoint), TAPI event log (bukan kolom agregat) sebagai source-of-truth, dengan fungsi pure terpisah untuk rekonstruksi read-time (dipakai UI bisa, dipakai bridge-crash-recovery bisa, DUA konsumen SATU fungsi murni). Layak ditiru verbatim, sama-sama TypeScript.
4. **Klasifikasi retry per-jenis-kegagalan, bukan retry generik** (`src/runs/reap/pr-open.ts:19-40`, `isRetryablePrResult`) — daftar eksplisit "mana error yang permanent, mana yang transient" untuk SATU API spesifik (GitHub PR open), bukan retry loop generik di client HTTP. Sejalan dengan prinsip "idempotency per-route" yang ditulis eksplisit di `burrow-client/client.ts:19-24" ("No retry/backoff loop... explicit failure not hidden retry").
5. **Salvage-before-destroy** (desain di `docs/design/runtime-provider-contract.md:248-272`, implementasi `src/runs/reap/salvage.ts`) — pola dua lapis (rescue-branch push origin + git-bundle lokal) untuk mencegah commit agent hilang saat finalize gagal push, sebelum sandbox dihancurkan. Relevan langsung untuk kebutuhan #5 kami — kapan pun sandbox itu fana (Docker container yang akan dihancurkan), commit yang belum ter-push adalah risiko data-loss yang sama.

**Yang TIDAK layak ditiru / dihindari:** model `plan_run_children` sekuensial-tunggu-merge kalau kebutuhan kami memang fan-out paralel — itu solusi untuk masalah yang berbeda (satu antrean issue GitHub, bukan DAG umum). Juga hindari over-fit ke "satu agent CLI yang self-report cost via stdout JSON" sebagai satu-satunya sumber — Warren tidak punya fallback token-counting independen, jadi agent/provider baru yang tidak melaporkan usage akan punya kolom cost kosong selamanya (`acc.seen` tetap false, C3).
