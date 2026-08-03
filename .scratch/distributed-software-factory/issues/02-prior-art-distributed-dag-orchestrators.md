# Prior art: orkestrator DAG dengan worker pull-based

Type: research
Status: resolved
Blocked by: —

## Question

Sistem yang sudah matang menyelesaikan masalah "worker outbound-only mengambil kerja dari DAG" dengan pola apa, dan mana yang layak dicontek?

**Sebagian sudah terjawab oleh ticket 00.** Pembacaan source owainlewis/factory sudah memberi pola konkret untuk leasing (poin 2), heartbeat dan deteksi mati (poin 3), serta idempotensi dan retry (poin 7) — lihat jawaban ticket 00 dan `research/owainlewis-factory.md`. Jangan ulangi itu. Yang tersisa dan masih gelap:

- **Eksekusi DAG** (poin 4) — fan-out, join, kegagalan sebagian, dan cancel yang merambat. Tidak satu pun kandidat di ticket 00 punya DAG yang benar-benar terdistribusi, jadi ini harus datang dari luar.
- **Perpindahan state antar step** (poin 5) — terutama karena ticket 01 menemukan sandcastle tidak pernah push ke remote, sehingga "git remote jadi bus" adalah lapisan yang kita bangun sendiri.
- **Log streaming** (poin 6) — batas 10MiB per attempt milik factory adalah backpressure paling kasar; cari pola yang lebih baik.
- **Durable execution dan signal** — prioritaskan **Temporal**. Ticket 00 menandainya sebagai sumber pola terdekat untuk step yang menunggu manusia, dan itu masalah tersulit di map ini.

Pelajari implementasi dan dokumentasi dari: **GitHub Actions self-hosted runner**, **Buildkite agent**, **Woodpecker CI**, **Drone**, **Temporal**, dan **Argo Workflows**. Ekstrak polanya, bukan fiturnya:

1. **Registrasi dan identitas worker** — bentuk join token, apa yang worker deklarasikan saat mendaftar (label, kapabilitas, jumlah slot), bagaimana identitas bertahan setelah restart, bagaimana worker dicabut aksesnya.
2. **Leasing pekerjaan** — bagaimana satu step diberikan ke tepat satu worker tanpa race saat banyak worker long-poll bersamaan. Lease dengan waktu kedaluwarsa, atomic claim di DB, atau antrean? Apa yang terjadi pada step yang sedang berjalan ketika worker mati diam-diam (bukan crash bersih).
3. **Heartbeat dan deteksi mati** — interval, ambang batas, dan apa yang dilakukan sistem saat lease kedaluwarsa: retry otomatis, gagalkan run, atau tandai perlu campur tangan manusia.
4. **Eksekusi DAG** — bagaimana fan-out dan join direpresentasikan. Bagaimana step join tahu semua cabang selesai. Bagaimana kegagalan sebagian ditangani (2 dari 3 cabang sukses). Bagaimana cancel merambat ke step yang sedang jalan di mesin lain.
5. **Perpindahan state antar step** — mana yang pakai artifact store, mana yang pakai git, mana yang memaksa satu run tetap di satu mesin, dan apa alasan yang mereka tulis.
6. **Log streaming** — jalur log dari runner ke UI. Chunking, backpressure, penyimpanan, dan bagaimana UI menampilkan live tail.
7. **Idempotensi dan retry** — bagaimana step yang diulang tidak menghasilkan efek samping ganda.

Untuk tiap pola, catat juga **biaya**-nya: komponen infra yang dibutuhkan dan kerumitan yang ditimbulkan. Kita membangun untuk tim internal yang self-hosted, bukan skala GitHub.

Keluaran: `.scratch/distributed-software-factory/research/orchestrator-prior-art.md`, ditutup rekomendasi ringkas: pola paling sederhana untuk leasing, heartbeat, join, dan cancel yang masih benar pada skala puluhan worker.

## Answer

Laporan lengkap dengan penandaan verifikasi per klaim: [`research/orchestrator-prior-art.md`](../research/orchestrator-prior-art.md).

### Step yang menunggu manusia — jangan ambil Temporal

Ini temuan terpenting. Event sourcing dan replay milik Temporal memecahkan masalah yang **berbeda** dari masalah kita: menyimpan program imperatif arbitrer secara durable, pada skala jutaan workflow, tanpa memaksa programmer menulis state machine eksplisit. Harganya adalah constraint determinism yang menyebar ke seluruh kode workflow, plus beban operasional replay dan versioning selamanya.

Kita tidak punya masalah itu. Graph kita **sudah** data — baris Run, Step, StepRun di Postgres. Kita sudah menulis state machine eksplisit. Dan yang menguatkan: **Argo, Airflow, Buildkite, dan GitHub Actions tidak satu pun memakai event-sourcing + replay** — semuanya memakai state di baris DB plus reconciliation loop. Itu kelas yang cocok untuk puluhan Runner.

Yang ditiru justru **Windmill**, yang dokumentasinya menyatakan tegas *"the worker is freed while suspended"*:

- StepRun `awaiting-human` adalah **baris DB tanpa lease aktif** — bukan proses yang idle.
- **Runner dan Sandbox dilepas sepenuhnya** begitu status itu masuk. Tidak ada proses menunggu pasif di mesin mana pun.
- Karena tidak ada state di memori proses mana pun, tahan restart control plane datang gratis.
- Resume = penjadwalan StepRun biasa lewat jalur yang sudah ada, dengan jawaban sebagai input. Tidak butuh mekanisme replay terpisah.

Ini juga memberi definisi tegas untuk **arti "hidup"**, yang selama ini jadi pertanyaan tergelap di map: *Run hidup* = baris Run berstatus aktif. *StepRun sedang menghitung* = ada Runner memegang lease atasnya. *StepRun menunggu manusia* = tidak ada lease sama sekali, murni status di DB plus Question menunggu jawaban. Biaya infra tambahan: nol.

### Fan-out, join, dan kegagalan sebagian

**Key bermakna terbukti benar.** Argo memakai item berkunci; Airflow memakai `map_index` integer dan harus menambal dengan `map_index_template` di 2.9 setelah user mengeluh tidak bisa membedakan cabang di UI. Keputusan ticket 05 menghindari kelas masalah yang Airflow tambal belakangan.

**Join cukup kueri DB.** StepRun kita sudah baris Postgres, jadi Join tinggal `SELECT output FROM step_run WHERE run_id = ? AND step_id = ?` lalu agregasi di kode — pola Airflow XCom. Tidak perlu file manifest atau artifact store untuk ini.

**Kegagalan sebagian: enum kecil per-Join** — `ALL_SUCCEEDED` / `ANY_SUCCEEDED` / `ALL_DONE`. Ini subset dari 11 `trigger_rule` Airflow yang benar-benar dipakai orang; Airflow sendiri mengakui sisanya sumber salah pakai.

**Dan satu jebakan yang harus dihindari sejak awal**: Argo punya kelas bug terbuka (issue #13498, #12530, #11395) di mana `continueOn` membuat Workflow dilaporkan **sukses** padahal ada task yang gagal. Akarnya satu flag menjawab dua pertanyaan berbeda. **Pisahkan tegas di skema data**: "apakah StepRun hilir dijadwalkan" dan "apakah Run dianggap sukses" adalah dua keputusan independen.

### Cancel

Untuk Runner outbound-only tidak ada pola push yang valid. Dua yang dipakai industri: poll di heartbeat yang sudah ada (Buildkite — latensi ~10 detik, wajar untuk StepRun berdurasi menit), atau menumpang di kanal long-lived kalau kita memang sudah membangunnya untuk log streaming.

Cacat GitHub Actions yang harus dihindari: runner mereka hanya menyinyal proses **top-level**, dan bash tidak meneruskan sinyal saat blocking wait — sehingga mayoritas proses turunan mati kasar tanpa kesempatan cleanup (diakui di actions/runner#1846). **Runner kita harus mengirim SIGTERM ke seluruh process group Sandbox**, lalu grace period, lalu SIGKILL.

### Git sebagai bus — peringatan keras

**Tidak ditemukan satu pun orkestrator produksi matang yang memakai git sebagai jalur perpindahan data antar step.** Argo mendukung git sebagai input artifact tetapi **secara eksplisit tidak sebagai output** — tabel dukungan resminya menandai output git = tidak. Mereka mewajibkan S3/MinIO begitu ada kebutuhan output-satu-step-jadi-input-step-lain. GitLab CI memakai object storage. Concourse memakai git sebagai unit versi yang mengalir, bukan sebagai tempat tiap job mendorong hasil kerjanya.

Ini **tidak berarti keputusan kita salah** — untuk agent AI yang keluarannya memang commit secara alami, git sebagai bus masuk akal, dan kosakata kita sudah memitigasi alasan Argo menolaknya dengan memisahkan Output (kecil, terstruktur) dari Artifact (besar, untuk manusia). Tapi kita harus sadar sedang membangun di wilayah tanpa cetak biru pada bagian mekaniknya: penamaan branch, retensi, dan garbage collection harus kita prototipe dan uji sendiri.

Skema penamaan yang disarankan: `<prefix>/<run-id>/<step-key>/<attempt>`. Retensi: **jangan hapus berdasarkan umur** — hapus saat Run selesai **dan** SHA-nya tidak lagi dirujuk Ref aktif mana pun. Disiplin yang wajib dijaga: jangan biarkan Artifact besar menyelinap masuk ke commit yang didorong StepRun, karena itu persis alasan Argo melarang git sebagai output.

### Log streaming

Batas 10MiB per attempt milik factory diganti dengan backpressure di laju, bukan cap ukuran:

- Runner mengirim chunk **bernomor sequence eksplisit** (bukan mengandalkan urutan kedatangan). Sequence itu juga yang membuat resume-setelah-putus mungkin — chunk yang belum di-ack dikirim ulang.
- Backpressure menumpuk **di sisi Runner** dengan cap lokal, bukan menekan Postgres.
- Simpan sebagai **blob append-only per attempt**, bukan baris DB. Baris per baris log adalah I/O berat untuk Postgres yang juga jadi source of truth Run.
- **Live-tail dan arsip-untuk-dicari adalah dua masalah berbeda** — Argo sendiri mengakui fitur arsip log mereka tidak dirancang untuk pencarian. Jangan desain satu mekanisme untuk keduanya.
- UI: **satu tab per Key**, jangan pernah menggabung log lintas cabang jadi satu aliran. Ini pola konsisten di Argo, Buildkite, dan GHA — dan selaras dengan keputusan Key bermakna.

### Konsekuensi yang harus dicatat

Rekomendasi log dan Artifact keduanya menunjuk ke **blob store** (MinIO self-hosted). Ini komponen infra yang belum ada di rencana. Kalau ticket 15 memang memutuskan Artifact butuh blob store, log tinggal menumpang di sana — bukan komponen ketiga yang berdiri sendiri. Kalau ticket 15 memutuskan sebaliknya, keputusan log harus ditinjau ulang.

Konsekuensi ke ticket lain: 06 (fan-out, join, enum kegagalan, pemisahan dijadwalkan-vs-sukses, cancel), 07 (arti "hidup", cancel lewat heartbeat), 14 (Windmill sebagai model, bukan Temporal — Runner dilepas saat menunggu), 15 (blob store, pemisahan Output vs Artifact), dan kabut log streaming yang kini sudah berbentuk.
