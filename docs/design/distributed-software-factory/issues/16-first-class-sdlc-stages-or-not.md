# Tahapan SDLC: konsep kelas satu, atau pipeline biasa

Type: grilling
Status: resolved
Blocked by: 05, 15

## Question

"Seluruh alur pengembangan jalan di sini" itu berarti produk mengerti apa itu *requirement*, *review*, dan *ticket* — atau produk cuma mesin generik dan alur itu sekadar pipeline yang kebetulan ditulis orang?

Ini pertanyaan bentuk produk, dan ia menentukan seberapa besar model data serta UI-nya. Dua jalur:

- **Mesin generik**: yang ada di produk cuma Pipeline, Step, Artifact, Worker. Alur SDLC dikirim sebagai pipeline contoh yang bisa diubah. PRD adalah artefak markdown dari step interaktif — tidak ada tabel `requirements`. Satu model data, satu artifact inspector, tidak terkunci pada satu metodologi. Harganya: UI generik, tidak ada layar khusus PRD atau papan ticket.
- **Tahapan kelas satu**: ada entitas Requirement, Design, Ticket, Review dengan skema, layar, dan aturan transisi masing-masing. Pipeline menggerakkan perpindahan antar tahap. UI jauh lebih kaya. Harganya: model data berlipat, terkunci pada satu metodologi, scope membengkak besar.

Yang harus dijawab:

1. **Pilih jalurnya**, atau nyatakan jalur ketiga: generik sekarang tapi wajib membuktikan tahapan kelas satu bisa dibangun di atasnya nanti tanpa membongkar model data.
2. **Uji dengan kasus nyata** — ambil satu alur penuh (ide → PRD → rencana → implementasi → review → merge) dan tuliskan bagaimana ia direpresentasikan di masing-masing jalur. Jalur generik biasanya terlihat baik-baik saja sampai ditanya: bagaimana orang menemukan "semua PRD yang belum disetujui"?
3. **Batas dengan alat yang sudah dipakai** — kalau tahapan jadi kelas satu, sistem ini mulai bersaing dengan GitHub Issues dan Jira. Di mana batasnya, dan apa yang tetap diserahkan ke alat lain? Menjawab ini mungkin langsung menutup salah satu jalur.
4. **Kontinuitas antar run** — sebuah PRD dibuat di run A, lalu dipakai run B sebagai masukan. Bagaimana run B menemukannya? Jalur generik butuh cara menamai artefak lintas run; jalur kelas satu mendapatkannya gratis. Ini uji paling tajam antara keduanya.
5. **Konsekuensi ke UI** — sebutkan daftar layar untuk masing-masing jalur. Selisihnya biasanya menjelaskan biayanya lebih jujur daripada argumen model data.

Zoom ke ticket 15 — kalau model artefak sudah cukup kuat memikul kontinuitas antar run, jalur generik menang dengan mudah.

**Yang ticket 15 berikan, dan yang tidak.** Diberikan: Artifact punya `key` bermakna dan `kind` tertutup, jadi "PRD" adalah objek yang bisa dinamai dan dirender. **Tidak** diberikan: `key` hanya unik **per StepRun** dan stabilitasnya lintas StepRun cuma konvensi — tidak ada indeks lintas Run, dan Artifact dihapus 90 hari setelah Run berakhir. Jadi pertanyaan 4 justru menajam, bukan lunak: jalur generik harus menjawab bagaimana run B menemukan PRD milik run A **tanpa** entitas yang hidup lebih lama dari retensi artefak. Pertanyaan 2 mewarisi bentuk yang sama — "semua PRD yang belum disetujui" adalah kueri lintas Run atas sesuatu yang sengaja tidak diindeks lintas Run.

## Answer

**Mesin generik.** Tidak ada entitas Requirement, Design, Ticket, atau Review. Yang ada di produk tetap Pipeline, Step, Run, StepRun, Output, Artifact, Runner, Question — tidak satu pun bertambah karena ticket ini.

Jalur generik tidak menang karena lebih murah. Ia menang karena pertanyaan 4 — kontinuitas antar Run, yang ticket ini sendiri sebut uji paling tajam — ternyata **salah alamat**.

### Kontinuitas bukan urusan model artefak

Ticket ini menuntut jalur generik menjawab bagaimana Run B menemukan PRD milik Run A tanpa entitas yang hidup lebih lama dari retensi artefak. Pertanyaannya mengandaikan Artifact adalah rumah PRD. Ia bukan.

**Rumah durable sebuah PRD adalah file di repo**, di-commit dan didorong lewat PR seperti perubahan kode mana pun. Artifact hanyalah salinan yang tertinggal untuk dibaca di UI. Dengan begitu:

- `key` yang cuma unik per StepRun tidak jadi masalah — ia tidak pernah dipakai untuk menemukan apa pun lintas Run.
- Retensi 90 hari tidak jadi masalah — yang hilang setelah 90 hari adalah salinan, bukan dokumennya.
- Tidak ada indeks lintas Run yang perlu dibangun, karena git sudah jadi indeksnya.

Ini bukan mekanisme baru: ticket 08 sudah menaruh definisi Pipeline di repo dengan alasan yang sama, dan `CONTEXT.md` sudah menyatakan git remote sebagai jalur perpindahan kerja antar mesin. PRD ikut jalur yang sudah ada.

**Run B menunjuk PRD lewat kejadian git dengan path filter** — merge PR yang menyentuh `docs/prd/*.md` memicu pipeline hilir, dan path file yang berubah itulah masukannya. Nol konsep produk baru; mekaniknya jatuh ke ticket 22. **Run tidak punya `inputs:`** dan tidak diberi satu pun di sini.

Harganya dinyatakan di muka: menjalankan ulang untuk PRD lama menuntut commit baru, dan tombol "implement PRD ini sekarang" di UI tidak ada. Itu masuk kabut sebagai *Run berparameter*, aditif murni.

### Satu Run sampai PR terbuka, dan di situ batasnya

Keputusan 1 dan 2 sendiri memberi bentuk **rantai Run** — tiap tahap satu Run, disambung merge. Tapi ticket 14 sengaja membangun Run yang boleh menggantung berhari-hari tanpa biaya (`awaiting-human` = baris DB tanpa lease). Dua keputusan itu menarik ke arah berlawanan, dan ketegangannya harus diputus, bukan didiamkan.

**Satu Run membawa ide sampai PR terbuka.** Persetujuan di tengah alur — PRD oke? rencana oke? — adalah Question `approval` ticket 14, di dalam Run yang sama. Begitu PR terbuka, Run berakhir dan GitHub mengambil alih review dan merge; ticket 10 sudah mengunci bahwa factory tidak pernah merge.

Itu memberi batas dengan alat yang sudah dipakai tim (pertanyaan 3) dalam satu kalimat: **factory memiliki segalanya sebelum PR ada, GitHub sejak PR ada.** Rantai Run tetap hidup sebagai jalur sekunder, dipakai kalau sebuah tim sengaja memecah alurnya jadi beberapa Pipeline.

Konsekuensi yang mudah terlewat: alur ide→PR menghabiskan hampir seluruh umurnya **sebelum** PR ada, jadi pelaporan status ke GitHub nyaris tidak berlaku untuknya. Yang membutuhkannya adalah arah sebaliknya — pipeline review/test yang **dipicu oleh** PR manusia. Dua arah itu bertemu di keputusan tulis-balik di bawah.

### Tidak ada entitas payung

Sebuah fitur menghabiskan beberapa Run: PRD ditolak lalu diulang, review minta perbaikan, follow-up PR. **Run tetap unit tertinggi di factory.** Yang menyatukan Run-Run itu adalah GitHub issue atau PR yang sama.

Entitas payung (`Work`, `Feature`) ditolak karena ia pintu masuk yang sesungguhnya: sekali ada tempat menaruh status keseluruhan, akan diminta assignee, board, dan aturan transisi — dan saat itu factory sudah menjadi issue tracker kedua bagi tim yang sudah punya satu. Pembagiannya tegas: **GitHub dan Jira memegang "apa yang harus dikerjakan dan oleh siapa"; factory memegang "apa yang sedang dan sudah dijalankan".**

`parent_run_id` ticket 06 tetap seperti adanya — silsilah untuk rewind, bukan tulang punggung pekerjaan.

### Tahapan kelas satu: out of scope, bukan kabut

Jalur ketiga yang ditawarkan pertanyaan 1 — generik sekarang, tapi wajib membuktikan tahapan kelas satu bisa dibangun di atasnya nanti — **ditolak**. Tidak ada keputusan model data setelah ini yang tunduk pada uji "bisa dinaikkan tanpa migrasi merusak".

Alasannya keputusan sebelumnya: manajemen pekerjaan sudah diserahkan ke GitHub. Menariknya kembali bukan penambahan di atas map ini, melainkan destination lain. Ia dicatat di **Out of scope**, bukan di Not yet specified.

### Tulis-balik ke GitHub

Ticket 10 menulis "factory membuka PR" tanpa menyebut siapa, sementara token Sandbox dikunci `contents:write` dan tidak lebih. Membuka PR butuh `pull_requests:write`. Lubang itu ditutup di sini.

**Control plane yang menulis; Sandbox tidak pernah melewati `contents:write`.** Sandbox hanya push branch. Seluruh tulis-balik dilakukan control plane dengan installation token-nya sendiri, sehingga agent yang dibujuk lewat teks yang ia baca — kelas serangan CVE-2025-66032 di ticket 04 — tidak pernah memegang izin menulis ke PR.

**`kind: pull-request` adalah Step bawaan yang tidak pernah diklaim Runner.** Ia Step biasa di YAML dengan `after:` sendiri, punya `attempts` dan `outcome` sendiri, dan di bawah fan-out ia lahir sekali per cabang — sehingga PR-per-repo untuk kerja lintas repo ticket 08 jatuh gratis tanpa aturan baru. Alternatifnya, `publish: pr` sebagai sifat Step agent, ditolak karena kegagalan membuka PR lalu harus memilih antara menggagalkan StepRun agent yang sudah sukses atau gagal senyap — mode kegagalan yang persis ditolak ticket 15 untuk upload artefak.

Ini melahirkan **kelas kedua StepRun yang tak punya lease dan tak pernah dikembalikan `/claim` ticket 07**. Preseden bentuknya sudah ada di `awaiting-human` ticket 14, tapi mekanik eksekusinya belum — itu ticket 24.

**Judul dan body PR datang dari Output berskema** milik StepRun yang ada di `after:`-nya, wajib lolos skema tetap `{ title, body }`. Agent tetap penulis narasinya, lewat Output tervalidasi dan bukan lewat izin GitHub. Nol mekanisme baru — ini kontrak Output ticket 05, notasinya urusan ticket 23. Gagal validasi menggagalkan StepRun `pull-request` saja; branch sudah aman di remote.

**Status ke PR lewat Commit Status API**, satu panggilan per transisi state Run ke SHA head, `details_url` menunjuk halaman Run. Scope `statuses:write`, satu endpoint, nol webhook baru, dan branch protection bisa mewajibkannya seperti check CI lain. Checks API ditolak: anotasi per baris dan tombol re-run bawaan menambah `checks:write` plus webhook `check_run.rerequested` yang jadi muatan baru untuk ticket 22 — sementara temuan review yang naratif sudah punya rumah sebagai Artifact yang dibaca di UI factory.

**Permukaan tulis berhenti di dua izin**: `pull_requests:write` untuk membuka PR, `statuses:write` untuk melapor status. Tidak ada komentar, tidak ada label, tidak ada tulisan ke issue. Tautan dua arah sudah lengkap tanpa API tambahan — Run→PR lewat Output step `pull-request`, PR→Run lewat `details_url`. Sticky comment ditolak karena menjadi sumber kebenaran kedua yang basi kalau edit gagal; label ditolak karena menjadi state yang harus dibereskan saat Run mati di tengah, masalah yang commit status tidak punya karena ia menempel ke SHA.

### Konsekuensi ke UI (pertanyaan 5)

Daftar layar jalur generik, dan tidak satu pun bertambah karena ticket ini:

Project · Repository · daftar Pipeline (dibaca dari repo, bukan didaftarkan) · daftar Run · detail Run berisi Graph · detail StepRun berisi log dan Artifact · inspector Artifact yang generik atas `kind` (markdown, diff, teks, biner) · **inbox Question** lintas Run dan lintas Project · kolam Runner · pengaturan Project (credential, secret, Group, anggota) · audit log.

Yang tidak ada: layar PRD, papan ticket, daftar requirement, papan review. "Semua PRD yang belum disetujui" (pertanyaan 2) tidak dijawab factory — ia adalah daftar PR terbuka di GitHub. Yang factory jawab adalah "apa yang menunggu saya", dan itu inbox Question yang ticket 14 sudah mewajibkan ada.

### Pengaruh ke ticket lain

- **15** — model artefaknya bertahan utuh. Lubang yang ticket ini khawatirkan (`key` per-StepRun, retensi 90 hari) ternyata bukan lubang, karena kontinuitas tidak pernah lewat sana.
- **14** — Question `approval` naik jadi mekanisme persetujuan utama di tengah alur, bukan kasus pinggiran. Run yang menggantung berhari-hari adalah bentuk baku, bukan pengecualian.
- **10** — lubang "siapa yang membuka PR" ditutup: control plane, bukan Sandbox.
- **07** — `/claim` sekarang punya jenis StepRun yang tidak pernah ia kembalikan. Mekaniknya di ticket 24.
- **22** — path filter jadi kebutuhan tegas, bukan pilihan; ini yang membawa PRD dari Run A ke Run B.
- **23** — mendapat konsumen konkret pertama: skema `{ title, body }` untuk step `pull-request`.
- **13** — Graph yang dirender sekarang bisa memuat simpul yang tidak dijalankan Runner mana pun.
- Premis map "PRD adalah artefak markdown dari sebuah step, bukan entitas produk tersendiri" — **dikonfirmasi**; klausa "kecuali ticket 16 memutuskan sebaliknya" gugur.
