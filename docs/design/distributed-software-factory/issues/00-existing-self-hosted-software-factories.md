# Apakah sudah ada yang menjawab kebutuhan ini

Type: research
Status: resolved
Blocked by: —

## Question

Adakah software factory / workflow engine yang open source dan bisa self-host, yang sudah memenuhi cukup banyak kebutuhan kita sehingga membangun sendiri jadi keputusan yang salah?

Ticket ini bernomor `00` karena ia mendahului semuanya. Kalau jawabannya "ada", sebagian besar map ini gugur atau berubah bentuk dari "rancang sistem" jadi "rancang lapisan di atas X".

### Kriteria penilaian

Nilai tiap kandidat terhadap sembilan hal ini, dan tandai tegas mana yang **ada**, **ada tapi setengah**, dan **tidak ada**:

1. DAG dengan fan-out, di mana cabang bisa jatuh ke mesin berbeda
2. Worker yang didaftarkan, outbound-only, sanggup hidup di belakang NAT
3. Step yang berhenti menunggu manusia — berdurasi jam atau hari, tahan restart
4. Percakapan dua arah dengan manusia di dalam step, bukan sekadar tombol approve/reject
5. Menjalankan AI coding agent di sandbox (Docker) dengan repo ter-checkout
6. Artefak per step yang bisa diperiksa di UI
7. Editor visual yang menghasilkan definisi berbentuk kode
8. Self-host penuh, tanpa ketergantungan ke layanan berbayar
9. Multi-user dengan peran dan isolasi credential

### Kandidat utama — sudah disaring awal

Dua ini ditemukan lebih dulu dan **wajib dinilai sampai ke source code**, bukan berhenti di README.

**[Fabro](https://github.com/fabro-sh/fabro)** — Rust, MIT, ~1.5k★. Menyebut dirinya "dark software factory". Dari pembacaan awal ia memenuhi tujuh dari sembilan kriteria: workflow berupa graph DOT dengan branching/loop/paralelisme/human gate, **approval gate** dan **interview step yang mengumpulkan input terstruktur** (setara grilling session), git checkpointing tiap stage, web UI React, self-host lewat docker compose, sandbox provider `local`/`docker`/`daytona`, auth lewat GitHub App OAuth dengan daftar `allowed_usernames` di `settings.toml`.

Dua kesenjangan yang justru menyentuh inti kebutuhan kita — **ini yang harus diverifikasi di kode**:

- *Worker terdistribusi yang didaftarkan.* Modelnya tampak "satu server, banyak sandbox". Tidak terlihat konsep mesin yang mendaftar lalu menarik kerja. Jalur scale-out-nya Daytona, bukan mesin milik sendiri. Periksa: adakah abstraksi yang memungkinkan sandbox berjalan di host lain, atau `local`/`docker` selalu berarti mesin yang sama dengan server?
- *Multi-user berperan.* `allowed_usernames` adalah allowlist, bukan RBAC, dan tidak terlihat isolasi credential antar user. Periksa seberapa dalam asumsi "satu tim, satu set credential" tertanam.

Periksa juga: adakah editor visual yang menghasilkan DOT, atau DOT hanya ditulis tangan dan UI sebatas papan monitoring? Dan seberapa terikat ia pada GitHub — apakah git host self-hosted didukung?

**[Warren](https://github.com/jayminwest/warren)** — TypeScript/Bun, MIT, ~199★, SQLite/Postgres via Drizzle. "Coolify for coding agents". Sandbox Bubblewrap per run, steer mid-run lewat `POST /runs/:id/steer`, cost/token tampil di UI, scale-out lewat pod-per-run di Kubernetes. Kesenjangannya lebih lebar: **tidak ada DAG** (hanya rantai serial yang menunggu PR sebelumnya di-merge), tidak ada registrasi worker, dan auth hanya satu bearer token bersama (OIDC masih di roadmap). Kemungkinan besar berakhir sebagai "contek polanya", bukan "bangun di atasnya" — tapi model runtime provider-nya yang bisa ditukar layak dipelajari.

**[owainlewis/factory](https://github.com/owainlewis/factory)** — Go + SQLite + React, MIT, ~107★, hanya ~141 commit. Control plane Go yang mendelegasikan kerja ke **worker polling di mesin terpisah**, dengan lease, attempt, event, dan worker health; UI menampilkan throughput, cycle time, queue depth. Ini persis arsitektur yang sudah kita kunci di Notes (worker menarik kerja, outbound-only). Agent runtime: Codex CLI atau Claude Code CLI yang sudah ter-autentikasi di host worker.

Yang tidak ada: DAG dan workflow yang bisa dipakai ulang (README menyebutnya "designed but not implemented"), human-in-the-loop, sandbox Docker (isolasinya hanya git worktree), dan autentikasi user sama sekali.

**Nilai terbesarnya untuk kita bukan sebagai basis, tapi sebagai pengukur biaya.** Ia mengimplementasikan lapisan worker terdistribusi — persis kesenjangan terbesar Fabro — dalam repo yang sangat kecil. Verifikasi ini: berapa banyak kode yang sesungguhnya dipakai untuk registrasi worker, leasing, dan heartbeat? Kalau jawabannya kecil, maka "tambahkan worker terdistribusi ke Fabro" berubah dari proyek besar jadi proyek sedang, dan itu menggeser seluruh keputusan.

### Kesimpulan sementara dari penyaringan awal

Tidak ada satu pun kandidat yang memenuhi semuanya, dan ketiganya saling melengkapi dengan rapi:

| | DAG | HITL | Worker terdistribusi | Sandbox | Auth multi-user |
|---|---|---|---|---|---|
| Fabro | ada | ada | tidak | ada | allowlist saja |
| owainlewis/factory | tidak | tidak | separuh | worktree saja | tidak ada |
| Warren | tidak | separuh | tidak | ada | token bersama |

**Dikoreksi setelah pembacaan source** (lihat `research/owainlewis-factory.md`): factory **tidak** punya worker terdistribusi. Control plane-nya loopback-only secara sengaja — dijaga di `internal/controlplane/server.go:18-48` dan `http.go:519-537`, dan dinyatakan sebagai keputusan arsitektur di `ARCHITECTURE.md:64-65` ("remote authentication and transport security are not implemented"). Bentuk protokolnya cocok untuk NAT karena worker selalu memulai koneksi, tapi transportnya memblokir mesin lain. Nilainya sebagai pengukur biaya tetap berlaku: lapisan worker seluruhnya ≈1.650 baris Go.

Sapuan lebar (lihat `research/broad-survey.md`) tidak menemukan kandidat yang mengalahkan ketiganya. Catatan lisensi yang menggugurkan: n8n memakai Sustainable Use License dan Drone memakai BSL — keduanya bukan open source sungguhan; Dify melarang multi-tenant tanpa izin tertulis; control plane Buildkite adalah SaaS. Laporan itu punya beberapa kontradiksi internal (Windmill dan Prefect dinilai berbeda antara tabel dan analisis) — perlakukan sel-selnya dengan hati-hati.

Riset ini harus menjawab: mana yang lebih murah — menambahkan worker terdistribusi dan RBAC ke Fabro, atau menambahkan DAG, HITL, dan sandbox ke factory? Jawabannya bergantung pada seberapa dalam masing-masing berasumsi tentang hal yang kurang itu. Sebuah asumsi "satu mesin" yang tertanam di seluruh core jauh lebih mahal daripada modul yang hilang.

### Kandidat lain

Jangan berhenti di daftar ini, tapi kandidat ini wajib dinilai:

- **Workflow engine berbasis kode**: Temporal, Argo Workflows, Prefect, Dagster, Kestra, Windmill. Perhatikan khusus Kestra dan Windmill — keduanya self-host, punya editor visual dua arah, dan punya pause-untuk-manusia.
- **Automation berbasis node**: n8n, Activepieces, Flowise, Langflow, Dify. n8n punya HITL dan self-host; nilai apakah ia sanggup memegang repo git dan sandbox Docker, atau berhenti di level integrasi API.
- **Platform coding agent**: OpenHands, SWE-agent, Sweep, Aider, Goose, Kilo/Roo. Nilai apakah ada yang punya orkestrasi multi-mesin, atau semuanya berhenti di satu mesin satu sesi.
- **CI self-hosted**: Woodpecker, Drone, Buildkite agent, Concourse. Kuat di worker dan DAG, hampir pasti lemah di HITL percakapan.
- **Developer portal**: Backstage, Port. Relevan untuk bingkai "seluruh alur pengembangan", bukan untuk eksekusinya.

### Yang harus dihasilkan

1. Tabel kandidat × sembilan kriteria.
2. Untuk dua atau tiga kandidat terkuat, gali lebih dalam: model ekstensinya seperti apa, apakah kebutuhan yang kurang bisa ditambal dari luar atau menuntut fork, dan seberapa sehat proyeknya (rilis terakhir, ukuran komunitas, lisensi — awas lisensi yang membatasi pemakaian komersial atau hosting).
3. **Kejujuran soal lisensi**: sebutkan mana yang open source sungguhan dan mana yang "source available" dengan syarat.
4. Rekomendasi berupa salah satu dari empat: *pakai X apa adanya*, *bangun di atas X sebagai mesin eksekusi*, *bangun sendiri sambil meniru pola dari beberapa*, atau *tidak ada yang cocok dan tidak ada yang layak ditiru*.
5. Kalau rekomendasinya "bangun di atas X", sebutkan ticket mana di map ini yang jadi gugur.
6. **Daftar tiruan, wajib diisi apa pun rekomendasinya.** Untuk tiap kandidat — Fabro, owainlewis/factory, Warren, dan sandcastle — sebutkan pola konkret yang layak ditiru beserta lokasinya di source: bentuk kontrak worker, cara lease dan heartbeat, cara graph direpresentasikan dan dieksekusi, cara human gate disimpan supaya tahan restart, cara log dialirkan, cara sandbox diabstraksi, dan skema tabel yang layak dicontoh. Bagian ini yang membuat satu pass riset berguna baik untuk hasil "adopsi" maupun hasil "bangun sendiri".
7. **Yang tidak terlihat dari README.** Untuk dua kandidat terkuat, cari secara khusus hal-hal yang tidak pernah masuk materi pemasaran tapi memakan waktu paling banyak: semantik retry, pemulihan setelah control plane restart, backpressure saat log membanjir, migrasi skema, worker berbeda versi, dan cancel yang merambat ke step yang sedang berjalan. Catat mana yang sudah dipecahkan dan mana yang ternyata juga belum.

### Tensi bahasa yang harus dijawab

Ketiga kandidat memakai bahasa berbeda — Fabro (Rust), owainlewis/factory (Go), Warren (TypeScript/Bun) — sehingga tidak bisa digabungkan. Memilih satu berarti menulis ulang sisanya.

Lebih tajam lagi: **mengadopsi Fabro kemungkinan besar berarti membuang sandcastle**, karena Fabro punya lapisan eksekusi agent sendiri di Rust sementara sandcastle adalah library TypeScript. Padahal sandcastle adalah premis awal effort ini, dan stack yang sudah dikunci adalah monorepo TypeScript.

Riset ini harus menyatakan tegas, untuk tiap rekomendasi: apa yang terjadi pada sandcastle, dan apa yang terjadi pada keputusan stack di Notes. Kalau rekomendasinya menuntut membatalkan salah satu keputusan yang sudah dikunci, katakan itu terang-terangan — jangan diam-diam diakali.

Keluaran: `docs/design/distributed-software-factory/research/existing-solutions.md`.

### Aturan bukti

Kandidat utama sudah disaring dari README dan dokumentasi. Itu materi pemasaran. Untuk Fabro dan Warren, **setiap klaim "ada" atau "tidak ada" harus menunjuk ke file dan baris di source code**, bukan ke kalimat di README. Kesenjangan yang salah dinilai di sini akan membuat seluruh map ini salah arah.

## Answer

**Bangun sendiri, sambil meniru pola dari keempatnya.** Tidak ada kandidat yang layak dijadikan basis. Sandcastle dipakai sebagai dependency untuk lapisan eksekusi agent.

Laporan lengkap dengan sitasi file:baris: [`fabro.md`](../research/fabro.md), [`owainlewis-factory.md`](../research/owainlewis-factory.md), [`warren.md`](../research/warren.md), [`sandcastle-api.md`](../research/sandcastle-api.md), [`broad-survey.md`](../research/broad-survey.md).

### Kenapa tidak ada yang bisa dijadikan basis

Ketiga kandidat gagal pada **kriteria yang sama**, dan kegagalannya struktural — bukan fitur yang belum sempat dibuat.

**Fabro** — dua dari tiga kebutuhan terpenting menuntut membongkar jantung arsitekturnya. "Worker"-nya adalah subprocess yang di-spawn server sendiri (`fabro-server/src/worker_runtime.rs:17-144`, `WorkerRef::Local{pid}`); tidak ada registrasi worker maupun job queue pull-based. Sandbox docker hardcode `Docker::connect_with_local_defaults()` (`docker.rs:169`) tanpa opsi remote host. Fan-out paralel (`handler/parallel.rs`) adalah `tokio::spawn` dalam satu proses dengan semua cabang berbagi satu instance sandbox — cabang di mesin berbeda mustahil tanpa mendesain ulang worker-spawning, sandbox provider, dan parallel handler sekaligus. Multi-tenant nihil: tidak ada tabel `users` di skema mana pun, tidak ada `owner_id` di `runs`/`automations`/`secrets`/`variables`, dan `secrets` ber-`PRIMARY KEY(name)` global (`fabro-db/migrations/2026071101_secrets.sql:1-2`) sehingga semua orang yang lolos `allowed_usernames` melihat kredensial yang sama. Ditambah 100% Rust melawan stack TypeScript kita.

**owainlewis/factory** — control plane **loopback-only secara sengaja**, dijaga di `internal/controlplane/server.go:18-48` dan `http.go:519-537`, dan dinyatakan sebagai keputusan arsitektur di `ARCHITECTURE.md:64-65` ("remote authentication and transport security are not implemented"). DAG terhalang di level skema: `executions.task_id` adalah `UNIQUE`. Dokumen "workflow" yang disebut README ternyata hanya soal template prompt bernama dan berversi, eksplisit menyatakan tidak menyentuh worker assignment, lease, atau attempt — bukan DAG. Tidak ada Docker sama sekali; isolasi hanya git worktree dan process group. Tidak ada auth.

**Warren** — hanya satu dari sembilan kriteria terpenuhi, dan yang paling penting: ia **mundur** dari kebutuhan kita. Multi-worker pool, fanout, dan placement pernah ada lalu dihapus (`src/burrow-client/local.ts:1-24`, "retired with K8s migration… nothing to fan out across"). State `paused`, kolom `paused_at`, serta mode run `interactive`/`conversation` pernah ada lalu dihapus eksplisit — ada migration test khusus untuk membuangnya (`drop-run-pause-columns.test.ts`, `core/wire.ts:56-62`). `plan-runs/coordinator.ts` adalah antrean linear (`pickNextPending LIMIT 1 ORDER BY seq`) yang sengaja dirancang sekuensial dengan gate menunggu PR di-merge. Implementasi sandbox-nya bahkan tidak ada di repo — itu paket eksternal `@os-eco/burrow-cli`.

**Sapuan lebar** tidak menemukan kandidat yang lebih baik. Celahnya nyata: orkestrator matang (Temporal, Kestra, Argo) kuat di DAG dan distribusi tapi tidak dirancang menjalankan coding agent di sandbox; platform coding agent (OpenHands, Goose) kuat di eksekusi dan interaksi tapi single-machine; platform workflow (Windmill, Prefect) kuat di HITL long-pause dan visual↔code tapi lemah di eksekusi agent terdistribusi. Tidak ada yang menggabungkan ketiganya.

Catatan lisensi yang menggugurkan kandidat: **n8n** memakai Sustainable Use License dan **Drone** memakai BSL — keduanya bukan open source sungguhan; **Dify** melarang multi-tenant tanpa izin tertulis; control plane **Buildkite** adalah SaaS.

### Yang dipakai: sandcastle sebagai dependency

Lihat ticket 01. Layak dipakai apa adanya, tanpa fork; semua kesenjangannya aditif.

### Daftar tiruan

**Dari owainlewis/factory — protokol worker.** Ini bagian yang paling matang di antara semuanya, dan seluruh lapisannya hanya ≈1.650 baris Go (server ~911, worker ~645, tipe protokol ~90). Angka itu penting: lapisan worker terdistribusi adalah modul berukuran sedang, bukan proyek tersendiri.

- Query leasing: `BEGIN immediate` + UPDATE bersyarat + cek `RowsAffected`, dengan partial unique index `one_active_attempt_per_execution` sebagai constraint fisik terakhir. Defense in depth, bebas race. Portabel ke Postgres lewat `FOR UPDATE SKIP LOCKED`. **Dipersempit oleh ticket 25 — index-nya tidak ikut ditiru.** `one_active_attempt_per_execution` melindungi model owainlewis yang menyimpan **tiap attempt sebagai baris baru**, sehingga dua attempt aktif untuk satu eksekusi bisa ditulis. Ticket 06 mengunci retry **menimpa baris StepRun yang sama**, jadi satu StepRun satu baris dan keadaan itu mustahil ditulis — primary key kita sudah memberikan constraint yang sama secara gratis. Yang tetap ditiru: UPDATE bersyarat + cek baris terpengaruh, `FOR UPDATE SKIP LOCKED`, dan klausa `count(*) < $slots` ticket 07 sebagai pagar slot.
- Dua heartbeat terpisah dengan window berbeda: worker-level (registrasi 10s, online window 30s) dan attempt-level lease (renew 10s, expire 30s, sweep tiap 5s).
- Sweep lease kedaluwarsa **sekali saat startup sebelum listener dibuka** — menutup lubang pemulihan setelah restart.
- Idempotency dua lapis: `claim_request` dan hash lease token.
- Batas log eksplisit 10MiB per attempt sebagai backpressure.

**Dari Warren — abstraksi runtime.** `RuntimeProvider` contract (`src/runtime/contract.ts`, 508 baris) adalah abstraksi provider paling matang dari semua kandidat: `RunHandle` yang opaque, `RuntimeCapabilities` untuk degradasi eksplisit, dan `finalize()` yang memecahkan "logika bergantung-workspace harus jalan dekat datanya" — persis masalah yang muncul saat step DAG berpindah mesin. Layak diadopsi hampir verbatim, dan kebetulan sama-sama TypeScript. Tambahan: `run_inbox` atomic-claim queue (`src/db/repos/run-inbox.ts:79-147`) sebagai primitif klaim, dan panen cost dari stdout JSON agent CLI (`usage-aggregate.ts`) — `total_cost_usd` milik claude-code, `turn_end.usage.cost` milik pi.

**Dari Fabro — model eksekusi dan state.** Event sourcing per run di blob store alih-alih SQL (`fabro-store/src/keys.rs`), checkpoint sebagai git commit (`fabro-checkpoint/src/git.rs`), graph engine generik lewat trait (`fabro-core`), sandbox trait yang sempit (`fabro-sandbox/src/provider.rs`), JWT worker token yang di-scope per run, dan cancel propagation lewat `CancellationToken` sampai ke SIGTERM/SIGKILL proses OS.

**Dari luar** — dua sumber pola yang layak dibaca meski tidak diadopsi: **Temporal** untuk durable execution dan signal (masalah persis ticket 14), dan **Windmill** untuk suspend/approve yang bertahan lama serta git sync visual↔code (ticket 08 dan 17).

### Peringatan yang dibawa pulang

Warren **mencoba** HITL yang memblokir — state `paused`, mode `interactive`/`conversation` — lalu membongkarnya karena tidak cocok dengan model batch-run-poll mereka. Itu bukti bahwa step-yang-menunggu-manusia harus dirancang ke dalam model eksekusi sejak awal, bukan ditambal di atas orkestrator yang berasumsi step berjalan sampai selesai. Ticket 14 harus memperlakukan ini sebagai temuan, bukan sebagai kekhawatiran.

### Akibat ke map

Tidak ada ticket yang gugur. Seluruh 18 ticket tetap hidup — inilah konsekuensi hasil "bangun sendiri": riset ini mengukuhkan map, bukan memangkasnya. Yang berubah: ticket 05 terbuka, dan ticket 12 kini condong kuat ke *dependency* sehingga tinggal menentukan batas isolasinya.
