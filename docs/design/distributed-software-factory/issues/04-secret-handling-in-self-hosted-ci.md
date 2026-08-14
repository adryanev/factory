# Cara sistem CI self-hosted menyimpan dan mengantar secret ke runner

Type: research
Status: resolved
Blocked by: —

## Question

Sistem CI self-hosted menyimpan secret di mana, dan bagaimana secret itu sampai ke proses yang berjalan di mesin lain tanpa bocor?

Ini penting karena worker kita menjalankan **AI coding agent**, yang memegang API key berbayar dan akses tulis ke repo, lalu mencetak banyak sekali teks ke log. Permukaan kebocorannya lebih besar daripada CI biasa.

Pelajari **Woodpecker CI**, **Drone**, **Buildkite**, dan **GitHub Actions** (secret + OIDC token exchange), lalu jawab:

1. **Penyimpanan** — enkripsi at-rest seperti apa. Kunci enkripsi disimpan di mana pada instalasi self-host. Adakah integrasi opsional ke Vault/SOPS dan seberapa berat.
2. **Scoping** — bagaimana secret dibatasi per repo, per pipeline, per user, atau per lingkungan. Bagaimana mencegah pipeline sembarangan membaca secret milik orang lain.
3. **Pengantaran** — secret sampai ke runner lewat jalur apa: menempel di payload job, diambil terpisah dengan token sekali pakai, atau di-mount sebagai file. Bagaimana ia masuk ke dalam container.
4. **Redaksi log** — bagaimana nilai secret disensor dari output. Apa yang gagal disensor dalam praktik (nilai ter-encode base64, terpotong, atau tercetak sebagian).
5. **Akses repo** — bagaimana runner mendapat kredensial untuk clone repo privat: deploy key, PAT, GitHub App installation token, atau token berumur pendek per job. Bandingkan risiko dan beban operasionalnya. Sertakan kasus **git host self-hosted** (Gitea/Forgejo), bukan hanya GitHub.
6. **Masa hidup** — apakah credential job berumur pendek, dan bagaimana ia dicabut ketika job selesai atau worker dicurigai bocor.

Keluaran: `docs/design/distributed-software-factory/research/secret-handling.md`, ditutup daftar rekomendasi minimum yang tetap aman untuk instalasi self-host oleh satu tim internal — jelaskan apa yang **tidak** perlu kita bangun.

## Answer

Laporan lengkap: [`research/secret-handling.md`](../research/secret-handling.md), 265 baris, 70 klaim bertanda `[VERIFIED-DOC]` atau `[IMPRESSION]`.

### Temuan yang mengubah cara kita memandang ancaman

**CVE-2025-66032 / GHSA-xq4m-mc3c-vvg3.** Claude Code berjalan di GitHub Actions; penyerang menanam prompt injection di isi sebuah GitHub issue; agent dibujuk menjalankan `cat /proc/self/environ`, mencuri OIDC token, lalu mendorong kode jahat ke dependency.

Kelima sistem CI yang dipelajari hanya mengantisipasi **"penyerang menulis pipeline.yml"**. Tidak satu pun punya threat model untuk **"agent dibujuk lewat konten yang ia baca"**. Ini kelas ancaman baru tanpa preseden di CI lama — dan ia langsung mengenai kita, karena Interactive Step kita memang dirancang membaca masukan manusia, dan Automation kita memang dirancang dipicu oleh isi issue dan komentar PR.

### Redaksi log: pertanyaan yang saya ajukan ternyata salah

Ticket ini bertanya di mana redaksi sebaiknya terjadi — di Runner atau di control plane. Jawabannya: **itu bukan pertanyaan yang menentukan**.

Buildkite meredaksi di sisi client, yang secara arsitektur paling aman, dan tetap punya bug produksi nyata (buildkite/agent#3588): pattern tidak di-anchor sehingga `*_SECRET` ikut mencocokkan `FAKE_SECRETS`, nilai di bawah 6 byte tidak diredaksi sama sekali, dan JSON dengan duplicate key membuat secret lolos. Semua vendor **eksplisit menyatakan redaksi tidak dijamin**.

Redaksi berbasis pencocokan pola punya celah fundamental di semua implementasi. Konsekuensinya untuk ticket 10: perlakukan redaksi sebagai **lapisan terakhir yang pasti bocor**, bukan sebagai kontrol utama. Kontrol utamanya adalah membatasi apa yang bisa keluar dari Sandbox sejak awal.

### Scoping: tidak ada preseden untuk model kita

Kelima sistem melakukan scoping per **tempat kerja** — repo, org, team, queue. **Tidak satu pun melakukan scoping per Principal.** Model kita — User dan ServiceAccount memegang credential berbeda di dalam Project yang sama — tidak punya cetak biru. Ini kesenjangan desain yang kita isi sendiri, dan patut dicatat sebagai kedua kalinya riset menemukan kita di wilayah tanpa peta (yang pertama: git sebagai bus, ticket 02).

### Penyimpanan

GitHub Actions selalu mengenkripsi (libsodium sealed box, di sisi client). **Woodpecker dan Drone membuat enkripsi at-rest opsional dan defaultnya mati — secret tersimpan plaintext.** Preseden buruk yang tidak boleh ditiru. Concourse tidak menyimpan secret sama sekali dan mewajibkan Vault/CredHub eksternal. Buildkite eksplisit menyarankan **jangan** menyimpan secret di dalamnya.

### Akses repo

Gitea dan Forgejo sudah punya token per-job bawaan (`GITEA_TOKEN`), ter-scope ke repo yang sedang dikerjakan, kedaluwarsa otomatis, dan bisa diatur Permissive atau Restricted. Ini pola paling murah untuk instance internal. **Jangan tiru GitHub App** — itu dirancang untuk marketplace SaaS multi-tenant dan berlebihan untuk kita.

### Pengantaran

Semua Runner outbound-only, dengan dua pola: long-poll job queue (GitHub Actions, Woodpecker, Buildkite, Drone) atau reverse SSH tunnel persisten (Concourse TSA). Mulai dari long-poll — lebih sederhana, dan sudah sejalan dengan keputusan koneksi kita.

### Rekomendasi minimum

- Enkripsi at-rest **wajib menyala**, AES-GCM dengan master key. Tanpa Vault.
- Secret di-resolve **saat penjadwalan**, bukan dimuat semua di muka.
- Token repo **per StepRun**, berumur pendek dan ter-scope, meniru pola Gitea.
- **Default-deny egress dari Sandbox.** Ini kontrol utama terhadap kelas ancaman CVE di atas, bukan redaksi log.
- Redaksi log minimum-viable di Runner sebelum persist — lalu berhenti. Jangan masuk perlombaan menyempurnakan regex.
- Approval gate untuk tindakan berdampak tinggi: mendorong ke branch yang bukan miliknya, dan jaringan di luar allowlist.

### Yang sengaja TIDAK dibangun

Vault/SOPS/age sebagai keharusan (berlebihan untuk satu tim), infrastruktur token bergaya GitHub App, pencabutan otomatis "cabut semua kredensial Runner X" (semua vendor pun manual), MITM TLS penuh untuk egress (filter SNI sudah cukup), dan perlombaan regex redaksi tanpa batas.

### Belum terverifikasi

Ditandai eksplisit di penutup laporan: mekanisme clone dan push milik Woodpecker dan Drone, lokasi persis redaksi di Woodpecker/Drone/Concourse, detail payload job message GitHub Actions, dan bootstrap master key pada GHES self-host. Kalau ticket 10 bersandar pada salah satu dari ini, verifikasi dulu.

Konsekuensi ke ticket lain: 10 (seluruh isinya), 11 (scoping per Principal tidak punya preseden), 14 (Interactive Step adalah permukaan prompt injection), dan kabut trigger otomatis (Automation dipicu isi issue — permukaan yang sama).
