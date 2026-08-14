# Model auth, tim, dan otorisasi

Type: grilling
Status: resolved
Blocked by: 03, 05

## Question

Siapa yang boleh masuk, siapa yang boleh menjalankan apa, dan bagaimana manusia dibedakan dari mesin?

1. **Login manusia** — pilih mekanismenya dari hasil ticket 03. Email+password lokal, atau OIDC ke identity provider yang sudah dipakai org? Ingat constraint self-hosted: apa pun yang dipilih harus bisa dijalankan sendiri tanpa layanan pihak ketiga.
2. **Auth mesin** — worker bukan user. Bagaimana join token diterbitkan, berapa lama berlaku, berapa kali bisa dipakai, dan kredensial berumur panjang apa yang worker pegang setelahnya. Konfirmasi bahwa ini jalur yang terpisah dari auth manusia.
3. **Peran** — daftar tertutup peran dan apa yang bisa dilakukan masing-masing. Dugaan awal: *admin* (kelola worker, secret, dan anggota), *maintainer* (kelola definisi pipeline), *member* (jalankan pipeline dan lihat run). Uji apakah tiga sudah cukup, atau bahkan terlalu banyak untuk satu tim internal.
4. **Batas otorisasi** — di mana pemeriksaan izin dilakukan. Aturannya: **diperiksa di tempat data dibaca**, bukan di lapisan route saja. Tetapkan ini sekarang supaya konsisten di seluruh spec.
5. **Kepemilikan** — siapa yang memiliki sebuah worker, sebuah pipeline, dan sebuah run. Bisakah member menjalankan pipeline apa saja, atau hanya yang repo-nya ia punya akses?
6. **Akses log** — log run bisa memuat isi kode dan jejak secret. Siapa yang boleh melihat log run milik orang lain.
7. **Akses API** — apakah manusia bisa memakai API/CLI langsung, dan kalau ya bagaimana token personal diterbitkan dan dibatasi.
8. **Audit** — tindakan apa yang harus tercatat: pembuatan worker, perubahan secret, perubahan peran, trigger run. Tanpa ini, insiden tidak bisa ditelusuri.

Ini juga menentukan bentuk navigasi dan layar pengaturan di UI.

Tambahan dari ticket 07: **siapa yang berhak mengizinkan `exec:host` untuk sebuah Project.** Runner mode host tidak memberi batas kontainer apa pun, jadi memakainya adalah keputusan keamanan sadar. Apakah izin itu sifat Project yang disetel admin org, peran tersendiri, atau cukup siapa saja yang boleh menyunting Pipeline.

## Answer

Digrill bersama ticket 10 dalam satu sesi identity & access.

### Login manusia — GitHub OAuth; vonis ticket 03 dibalik

Git host-nya GitHub (ticket 10), dan seluruh tim sudah punya akun GitHub. **Satu GitHub App yang sama melayani dua hal**: OAuth user login *dan* installation token untuk akses repo. Keanggotaan awal diverifikasi dari org GitHub; session disimpan di Postgres kita sendiri.

**Ini mematikan Zitadel.** Ticket 03 memilihnya karena federasi multi-IdP, role grant per-Project, dan audit event-sourced bawaan. Dengan IdP tunggal, ketiganya tidak terpakai — sisanya tabel Postgres dan sekitar 150 baris. Kita juga lolos dari AGPL-3.0 dan satu servis tambahan untuk dijalankan dan di-backup. Ticket 03 sudah menyiapkan jalan keluar ini secara eksplisit (*"session custom di atas Postgres… kalau ticket 11 memutuskan audit bawaan tidak sepadan dengan satu servis tambahan, opsi ini yang menang"*), jadi ini bukan pembongkaran melainkan cabang yang memang disediakan.

Dua hal yang menempel dan tidak boleh hilang:

- **Identitas GitHub hanya untuk otentikasi, tidak pernah untuk otorisasi.** Riset ticket 04 menemukan bug akar CVE-2025-66032 adalah `checkWritePermissions` yang mempercayai identity string berakhiran `[bot]` — siapa pun bisa membuat GitHub App dan dapat suffix itu gratis, tanpa write access ke repo mana pun. Izin dibaca dari tabel kita sendiri, titik.
- **Satu akun break-glass lokal**, dari config, bukan sistem password umum. Kalau GitHub down, kamu tetap harus bisa masuk untuk **cancel** Run yang sedang membakar kredit API. Tanpa ini, pemadaman pihak ketiga mengunci kita keluar dari rem darurat sendiri.

### Auth mesin — dikonfirmasi, jalur terpisah

Tidak berubah dari ticket 07 dan 03: tabel `runners` sendiri, join token sekali pakai ditukar jadi runner-id + secret di disk, seluruhnya di luar sistem identitas manusia. Pola GitHub Actions runner dan bootstrap token kubelet. Ini yang menjaga invarian **Runner ≠ Principal** secara struktural.

Satu hal baru dari ticket 10 yang mengikat ke sini: di Runner `exec:host`, proses Runner (`_factory`) dan proses agent (`_factoryjob`) adalah **dua user OS berbeda**, supaya agent tidak bisa membaca `runner.secret` dan menaikkan dirinya jadi Runner.

### Peran — dua per Project, satu di org

Dugaan awal ticket ini (*admin / maintainer / member*) **ditolak**. Memisahkan "kelola definisi Pipeline" dari "jalankan Pipeline" tidak berarti untuk satu tim internal di mana orang yang menulis pipeline adalah orang yang menjalankannya. Tiga peran untuk membedakan dua hal yang tidak pernah terpisah adalah kompleksitas yang dibayar setiap hari dan tidak pernah dipakai.

- **`admin`** (per Project) — anggota, secret, credential ServiceAccount, allowlist egress, `allowSharedAgentCredential`, Repository.
- **`member`** (per Project) — tulis Pipeline, jalankan Run, jawab Question, baca Artifact dan log.
- **`owner`** (level org, **bukan** Project) — daftar dan cabut Runner, terbitkan join token, buat Project, **beri izin `exec:host` ke sebuah Project**, dan patok Runner host-mode ke daftar Project.

Runner adalah sumber daya org — ticket 07 mengunci satu kolam milik org — jadi mengelolanya bukan wewenang per-Project.

**Menjawab tambahan ticket 07:** izin `exec:host` adalah **sifat Project yang diberikan `owner` org**. Bukan peran tersendiri, dan jelas bukan hak siapa saja yang boleh menyunting Pipeline. Host mode berarti tanpa batas kontainer, dan ticket 10 menaikkannya jadi jalur rutin untuk build Xcode — justru karena rutin, izinnya harus tetap keputusan sadar di level org, bukan sesuatu yang bisa dinyalakan sendiri oleh yang menulis Pipeline.

### Batas otorisasi

Aturan *"diperiksa di tempat data dibaca"* dipertegas jadi bentuk konkret: **`Principal` adalah argumen eksplisit di tiap fungsi baca**, bukan diambil dari context ambient. Lebih bertele-tele di ratusan tempat, dan itu harga yang dibayar sadar — context ambient (`AsyncLocalStorage` dan sejenisnya) lebih ergonomis tapi mode kegagalannya **diam**: izin lupa diperiksa dan tidak ada yang tahu sampai ada insiden.

Diperkuat lewat tipe: tidak ada satu pun fungsi yang bisa membaca secret **tanpa** `Principal`. Compiler yang menegakkan, bukan review. Untuk secret, `owner_principal_id` + `project_id` selalu ikut di kueri resolusi (detail di ticket 10).

### Kepemilikan

- **Runner** milik org, bukan Project atau individu. Dikelola `owner`.
- **Pipeline** milik Project. Semua `member` boleh menulis dan menjalankannya.
- **Run** dimiliki Project, dengan Principal pemicu tercatat sebagai atribut. Bukan "milik" pemicunya — kalau begitu, orang yang cuti berarti Run-nya tidak bisa dilihat siapa pun.

Batas keamanan berhenti di Project (ticket 05), jadi pertanyaan *"bisakah member menjalankan pipeline apa saja"* jawabannya: ya, di dalam Project-nya. Repository adalah anggota Project, bukan unit izin tersendiri.

### Akses log

`member` sebuah Project membaca **seluruh** log dan Artifact Project itu. Mereka sudah bisa membaca repo-nya; menyembunyikan log dari sesama anggota adalah teater. Lintas Project: nol.

Yang tidak sepele: **`owner` org tidak otomatis mendapat akses data Project.** Ia mengelola infrastruktur — Runner, join token, pembuatan Project — bukan isi. Untuk membaca log sebuah Project ia harus menambahkan dirinya jadi anggota, dan tindakan itu **tercatat di audit**. Jalan keluarnya ada dan meninggalkan jejak; itu bentuk yang benar, bukan superuser diam-diam.

### Akses API

Terbitkan PAT sendiri: prefix `sf_`, 32 byte acak, disimpan sebagai **hash SHA-256** — bukan bcrypt, karena entropinya sudah tinggi dan ini diverifikasi di tiap request. Izinnya **persis izin Principal pemiliknya**, tanpa sistem scoping terpisah (YAGNI untuk satu tim). Wajib bernama supaya bisa dicabut yang tepat, default kedaluwarsa 90 hari, dan `last_used_at` tampil di UI supaya token mati kelihatan dan bisa dibersihkan.

### Audit

Satu tabel `audit_log`, **append-only ditegakkan di level DB** — role aplikasi tidak diberi `UPDATE`/`DELETE`, bukan sekadar konvensi di kode. Sembilan jenis kejadian:

1. Daftar dan cabut Runner
2. Terbitkan join token
3. Buat / ubah / hapus secret — **nilai tidak pernah dicatat**, hanya nama, siapa, kapan
4. Ubah peran dan keanggotaan
5. Nyalakan / matikan `allowSharedAgentCredential`
6. Ubah allowlist egress
7. Beri izin `exec:host` ke Project
8. Picu Run
9. Terbitkan PAT

Tiap baris: Principal, tindakan, target, waktu, IP. Ini untuk **menelusuri insiden**, bukan kepatuhan formal — dan daftarnya sengaja pendek supaya tetap dibaca.

### Konsekuensi ke ticket lain

- **Ticket 03** — vonis Zitadel dibatalkan. Alternatif "session custom di atas Postgres" yang dipilih. AGPL-3.0 tidak lagi relevan.
- **Ticket 13 dan 17** — bentuk navigasi, layar pengaturan, dan siapa melihat apa mengikuti dua peran Project + satu peran org.
- **Kabut notifikasi** — model tim sudah beres, jadi patch itu bisa digraduasi.
