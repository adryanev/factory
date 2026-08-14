# Automation: bagaimana Run dipicu tanpa manusia

Type: grilling
Status: resolved
Blocked by: 08

## Question

Sebuah kejadian di GitHub atau sebuah jadwal berubah jadi Run dengan cara apa?

Ini naik dari kabut karena ticket 08 sudah menjawab yang menghalanginya: definisi tinggal di repo, dibaca dari ref yang dipicu, punya Repo Tuan Rumah, dan control plane sudah memegang cache definisi yang diperbarui lewat push. Semua bahan untuk merumuskan pertanyaannya sekarang ada. `CONTEXT.md` sudah menamai entitasnya — **Automation** — dan sudah mengunci bahwa ia berjalan sebagai ServiceAccount milik Project-nya.

1. **Di mana aturan trigger ditulis** — di dalam file definisi Pipeline itu sendiri (gaya GitHub Actions: `on: [push, pull_request]`), atau sebagai baris terpisah di DB yang disunting lewat UI. Yang pertama konsisten dengan "repo sumber kebenaran"; yang kedua menghadapi masalah yang sama dengan gerbang reviewer di ticket 08, dan mungkin punya jawaban yang sama.
2. **Pemetaan kejadian → Pipeline** — satu push menyentuh repo X pada ref R. Pipeline mana yang jalan: yang tuan rumahnya repo X, atau juga Pipeline lintas repo di repo config yang menyatakan repo X sebagai anggotanya. Yang kedua berarti control plane harus mencari lintas repo pada setiap kejadian, dan cache definisi ticket 08 baru punya alasan kuat untuk ada.
3. **Ref mana yang dipakai** — ticket 08 mengunci "definisi dari ref yang dipicu". Untuk push itu jelas. Untuk komentar di issue, untuk cron, dan untuk PR dari fork, ref-nya tidak jelas dan harus diputuskan satu per satu.
4. **Dedup** — satu push bisa datang dua kali (GitHub mengirim ulang), dan satu PR bisa menghasilkan beberapa kejadian untuk commit yang sama. Apa kunci idempotensinya, dan berapa lama diingat. Ticket 02 sudah membawa pola idempotency dua lapis dari owainlewis/factory.
5. **Concurrency** — dua push beruntun ke branch yang sama. Run kedua antre, membatalkan yang pertama, atau jalan bersamaan. Ini butuh kunci bernama per (Pipeline, ref), dan bawaannya harus dipilih.
6. **Cron** — jadwal ditulis di mana, dan Run cron memakai ref apa. Apa yang terjadi kalau Run sebelumnya belum selesai saat jadwal berikutnya tiba.
7. **Trigger dari isi yang bisa ditulis orang luar** — komentar issue dan PR adalah teks yang bisa ditulis siapa saja. Ticket 04 dan 11 sudah menetapkan bahwa identitas GitHub tidak pernah dipakai untuk otorisasi, dan CVE-2025-66032 adalah persis kelas serangan ini. Siapa yang boleh memicu Run lewat komentar, dan bagaimana itu diperiksa.
8. **Batalkan otomatis** — apakah Run yang dipicu Automation ikut dibatalkan ketika PR-nya ditutup atau branch-nya dihapus.

Rekomendasi awal untuk diuji: aturan trigger ditulis di dalam file definisi (konsisten dengan sumber kebenaran repo), pemetaan dilayani oleh cache definisi ticket 08, dedup memakai delivery id GitHub, dan bawaan concurrency adalah "batalkan Run lama pada (Pipeline, ref) yang sama".

## Answer

Tiga rekomendasi awal bertahan. Yang keempat — bawaan concurrency "batalkan yang lama" — **bertahan hanya sebagai bawaan, dan dipagari validasi**, karena diterapkan mentah ia membunuh grilling session 40 giliran tanpa suara.

Dua hal yang tidak diminta ticket ini tapi jatuh gratis: webhook tidak perlu didaftarkan per repo, dan satu kelas serangan penuh tertutup oleh satu baris.

### Aturan trigger di dalam file, plus satu sakelar operasional

Sub-pertanyaan 1 memilih opsi pertama. Blok `on:` di file definisi, alasannya sama persis dengan ticket 08: perubahan trigger ikut di-review bersama kodenya, dan trigger yang salah terbaca di diff.

```yaml
version: 1
name: Test tiap push
repo: frontend
on:
  push:
    branches: [main, "feat/**"]
  pullRequest: true
  schedule: ["0 3 * * *"]
```

Ticket 08 memecah satu hal keluar dari file — keanggotaan Group — karena mengganti reviewer tidak boleh butuh PR. Uji yang sama diterapkan di sini dan hasilnya berbeda: mengubah *kapan* sebuah Pipeline jalan adalah perubahan perilaku yang memang pantas di-review. Jadi tidak ada baris trigger di DB.

Satu pengecualian, dan ia operasional bukan editorial: **`automation_enabled` per Project**, boolean, dibalik `admin` dari UI. Tanpa itu, menghentikan webhook yang mengamuk atau memadamkan seluruh automation saat insiden menuntut PR ke tiap repo yang punya `on:` — persis saat orang paling tidak punya waktu untuk PR. Ia hanya bisa mematikan, tidak pernah menyalakan sesuatu yang tidak ditulis di file, jadi ia bukan jalur kedua untuk menyatakan trigger.

### Pendaftaran webhook jatuh gratis dari ticket 10

Tidak perlu memasang webhook per repo. Ticket 10 mengunci **GitHub App**, dan installation-nya sudah mengirim event untuk seluruh repo yang di-install padanya, ke satu endpoint, dengan satu secret. Yang harus dibangun: satu endpoint yang memverifikasi HMAC sebelum menyentuh payload, lalu menaruh event mentah di tabel dan menjawab 2xx. Seluruh pekerjaan pemetaan terjadi setelah itu, di luar jalur request GitHub.

### Pemetaan kejadian → Pipeline, dan ref yang dipakai

Sub-pertanyaan 2 memilih **keduanya**, dan cache definisi ticket 08 akhirnya punya alasan yang tidak bisa dibantah untuk ada.

Push ke repo X pada ref R memicu dua himpunan:

1. Pipeline yang **tuan rumahnya X** — definisinya dibaca dari **R**. Ini kasus lurus ticket 08.
2. Pipeline di **repo config Project** yang menyebut X sebagai anggota trigger-nya (`on: { push: { repos: [frontend, backend] } }`) — definisinya dibaca dari **default branch repo config**, bukan dari R, karena R tidak ada di repo itu.

Himpunan kedua adalah pencarian lintas repo pada setiap kejadian, dan tanpa cache ia berarti membaca tiap file definisi di tiap repo config pada tiap push. Dengan cache ia satu kueri indeks. Cache tetap **turunan murni** (ticket 08) — hilang berarti dibangun ulang, tidak pernah berarti Run yang salah.

Sub-pertanyaan 3, satu per satu:

| Kejadian | Ref definisi | Ref yang dijalankan |
| --- | --- | --- |
| `push` | ref yang dipush | sama |
| `pull_request` (buka, sinkron) | head SHA | sama |
| `schedule` | default branch tuan rumah | sama |
| Pipeline lintas repo | default branch repo config | ref kejadian pemicunya, per cabang |
| PR dari fork | — | **tidak pernah dipicu** |
| Komentar issue/PR | — | **tidak dibangun** (lihat di bawah) |

**PR dari fork diabaikan seluruhnya** — kalau head repo ≠ base repo, event dibuang. Satu baris, dan ia menutup kelas serangan penuh: definisi Pipeline dibaca dari head (supaya perubahan pipeline bisa diuji sebelum merge, ticket 08), jadi memicu dari fork berarti mengeksekusi definisi yang ditulis orang luar di atas Runner kita dengan ServiceAccount Project. Tim ini internal dan repo-nya privat, jadi fork bukan bagian dari alur kerjanya — harganya nol dan manfaatnya besar.

Cron membaca **default branch**, bukan ref lain, dan konsekuensinya perlu ditulis karena ia menyenangkan: sebuah PR tidak bisa menjadwalkan apa pun. Jadwal baru baru hidup setelah merge.

### Dedup: satu Run per (Pipeline, SHA)

Sub-pertanyaan 4 memakai idempotensi dua lapis ticket 02, dan lapis keduanya lebih tajam dari yang ticket ini bayangkan.

**Lapis 1 — penerimaan.** `X-GitHub-Delivery` sebagai primary key tabel event. Pengiriman ulang GitHub mendarat di `ON CONFLICT DO NOTHING`. Diingat **24 jam**, cukup untuk jendela redelivery GitHub, lalu dipangkas.

**Lapis 2 — pembuatan Run.** Kunci naturalnya **(Pipeline, SHA)**, bukan (Pipeline, SHA, jenis kejadian). Artinya: **satu Run per Pipeline per commit, berapa pun jumlah kejadian yang menggambarkan commit itu.** Push ke branch yang sudah punya PR terbuka mengirim `push` dan `pull_request.synchronize` untuk SHA yang sama; dengan kunci ini yang kedua tidak menghasilkan apa-apa.

Ini sengaja lebih opinionated daripada GitHub Actions, yang double-run untuk kasus ini dan mendorong orang menulis kondisi `if:` untuk menambalnya. Harganya dinyatakan: **sebuah Pipeline tidak bisa berperilaku beda antara push dan PR untuk commit yang sama.** Harga itu nol hari ini — definisi adalah data murni tanpa ekspresi (ticket 08) dan Run tidak punya `inputs:` (ticket 16), jadi tidak ada mekanisme apa pun yang bisa membaca jenis kejadian. Kalau nanti ada, keputusan ini yang harus ditinjau ulang lebih dulu.

Kunci ini disimpan sebagai unique index di `runs`, jadi lomba antar dua proses control plane berakhir di constraint DB, bukan di logika aplikasi — pola yang sama dengan ticket 07.

**Dikoreksi oleh ticket 25 — index-nya harus parsial.** Ditulis harfiah sebagai unique index polos atas `(pipeline_repository_id, pipeline_path, commit_sha)`, kunci ini **melarang dua fitur yang sudah dikunci di tempat lain**: rewind adalah Run baru ber-`parent_run_id` atas commit yang sama (ticket 06), dan pemicu manual lewat tombol UI adalah pengganti trigger komentar yang ticket ini sendiri putuskan (§ trigger komentar). Keduanya sah menghasilkan Run kedua untuk SHA yang sama.

Aturan "satu Run per commit" di bagian ini memang selalu berbicara tentang **Automation** — teksnya jelas soal itu — tapi constraint yang menegakkannya harus menyatakannya:

```sql
UNIQUE (pipeline_repository_id, pipeline_path, commit_sha)
  WHERE trigger_kind = 'automation' AND parent_run_id IS NULL
```

Nol perubahan pada keputusan ticket ini; yang berubah hanya bentuk yang menegakkannya.

### Concurrency: bawaan cancel, dan Interactive Step wajib menyatakan diri

Sub-pertanyaan 5 adalah tempat rekomendasi awal hampir menabrak keputusan ticket 14.

"Batalkan Run lama pada (Pipeline, ref) yang sama" benar untuk Pipeline gaya CI: dua push beruntun, yang lama tidak menarik lagi. Ia **salah total** untuk Pipeline yang memuat Interactive Step: sebuah push ke branch yang sedang jadi tempat grilling session berjalan akan membunuh percakapan 40 giliran, dan orang yang mengetiknya tidak pernah tahu apa yang ia hancurkan. Ticket 14 menghabiskan seluruh ticketnya membuat percakapan tahan restart, tahan Runner mati, dan tahan browser ditutup — lalu satu bawaan concurrency mencabutnya.

Jawabannya bukan aturan bersyarat ("cancel kecuali ada `awaiting-human`"), karena itu membuat satu bawaan berperilaku dua macam tergantung keadaan runtime — bentuk yang map ini tolak berulang kali. Jawabannya **validasi**:

```yaml
concurrency: cancel # cancel (bawaan) | queue
```

> Pipeline yang memuat sedikitnya satu Step ber-`ask:` **wajib menulis `concurrency:` secara eksplisit**. Menghilangkannya adalah error definisi.

Statis, terbaca saat validasi di control plane (ticket 08), dan mode kegagalannya **berisik alih-alih senyap** — penulis dipaksa memilih sekali, di file, dengan diff yang bisa di-review. Pipeline CI biasa tidak menulis apa pun dan mendapat `cancel`.

`queue` berarti Run kedua menunggu Run pertama berakhir. Antrean sedalam satu: Run ketiga menggantikan Run kedua yang masih mengantre, karena mengantre tiga versi dari branch yang sama tidak pernah berguna.

Cancel di sini memakai jalur cancel ticket 06 apa adanya — nol mekanisme baru.

### Cron: tumpang tindih dilewati, dan pelewatannya terlihat

Sub-pertanyaan 6. Jadwal ditulis di `on: { schedule: [...] }`, ref-nya default branch, Principal-nya ServiceAccount Project (sudah dikunci `CONTEXT.md`).

Saat jadwal tiba dan masih ada Run aktif untuk (Pipeline, ref) yang sama: **dilewati, dan pelewatannya dicatat sebagai baris yang terlihat di UI.** Bukan antre — cron yang mengantre menumpuk tanpa batas dan pukul tiga pagi berikutnya menemukan sepuluh Run menunggu. Bukan paralel, dengan alasan yang sama.

`concurrency: queue` tidak berlaku untuk cron; ia hanya mengatur kejadian git. Cron selalu skip. Ini satu-satunya tempat dua mekanisme concurrency hidup berdampingan, dan keduanya dipisah karena sumbernya berbeda: push datang dari manusia yang menunggu hasilnya, cron tidak.

### Trigger dari komentar: tidak dibangun

Sub-pertanyaan 7 dijawab dengan **tidak membangunnya**, dan alasannya struktural, bukan soal prioritas.

Sebuah komentar tidak membawa sesi. Satu-satunya identitas yang tersedia untuk memutuskan siapa yang boleh memicu adalah **identitas GitHub si penulis komentar** — dan ticket 11 melarangnya untuk otorisasi dengan kalimat yang tidak menyisakan celah: identitas GitHub hanya untuk otentikasi, tidak pernah otorisasi, karena akar CVE-2025-66032 adalah kode yang mempercayai atribut identitas yang bisa didapat siapa saja gratis. Ticket 04 menempatkan isi yang bisa ditulis orang luar sebagai kelas ancaman utama sistem ini. Membangun trigger komentar berarti membuat teks yang bisa ditulis siapa saja jadi pemicu eksekusi — permukaan yang persis itu.

Kebutuhannya sudah punya rumah: **tombol jalankan di UI**, yang duduk di belakang sesi login dan pemeriksaan keanggotaan Project ticket 11.

Harga dinyatakan: `/factory implement` di komentar PR tidak ada. Jalur masa depannya sudah dirumuskan supaya tidak perlu dipikirkan dari nol — identitas GitHub dipakai **sebagai kunci pencarian** ke User yang pernah login OAuth dan tertaut, lalu keanggotaan Project diperiksa di DB kita; otorisasi tetap bertumpu pada Principal, GitHub cuma pemetaan. Masuk *Not yet specified*, pemicunya permintaan nyata pertama.

### Batalkan otomatis: ya, lewat jalur yang sudah ada

Sub-pertanyaan 8. **Branch dihapus** ⇒ Run aktif yang ref pemicunya branch itu dibatalkan. **PR ditutup** ⇒ Run aktif yang dipicu PR itu dibatalkan. Keduanya memakai cancel ticket 06 apa adanya.

Termasuk Run yang sedang `awaiting-human` — dan itu tidak bertabrakan dengan keputusan sebelumnya. Bedanya tajam: `concurrency: cancel` membunuh percakapan yang **masih relevan** karena ada commit baru; menutup PR adalah manusia menyatakan pekerjaannya **sudah tidak relevan**. Yang kedua justru satu-satunya jalan keluar yang ticket 14 sediakan untuk Question yang menggantung selamanya.

Run yang dipicu manual dari UI tidak ikut terbatalkan oleh penghapusan branch — ia tidak punya ref pemicu dari kejadian git.

### Konsekuensi ke ticket lain

- **08 (closed)** — cache definisi naik dari optimasi jadi **wajib**: pemetaan lintas repo pada tiap kejadian tidak punya jalur lain. Sifat "turunan murni" tidak berubah.
- **14 (closed)** — dilindungi. Aturan `concurrency:` wajib-eksplisit ada semata-mata untuk menjaga keputusan ticket 14 tidak dicabut oleh sebuah bawaan.
- **10 (closed)** — GitHub App menutup pendaftaran webhook tanpa pekerjaan tambahan. Nol keputusan baru.
- **11 (closed)** — larangan "identitas GitHub tidak pernah untuk otorisasi" yang memutuskan sub-pertanyaan 7. Bukan koreksi, penerapan.
- **16 (closed)** — "Run dari kejadian git dengan path filter" sekarang punya mekaniknya. Path filter masuk sebagai `on: { push: { paths: [...] } }`, bagian dari blok yang sama.
- **19 (open)** — Run yang dipicu Automation berjalan sebagai ServiceAccount, jadi tidak ada manusia yang bisa dinotifikasi secara personal saat ia gagal. Notifikasi untuk Run gagal harus berskala Project, bukan per-pemicu.
- **13 (open)** — halaman daftar Run harus membedakan pemicu (manusia / push / PR / cron) dan menampilkan cron yang dilewati.
