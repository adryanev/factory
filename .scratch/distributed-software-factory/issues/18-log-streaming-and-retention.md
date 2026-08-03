# Jalur log: streaming langsung, penyimpanan, dan retensi

Type: grilling
Status: resolved
Blocked by: 15

## Question

Log dari sebuah StepRun berjalan dari Sandbox sampai ke mata orang di browser lewat jalur apa, disimpan di mana, dan dibuang kapan?

Ticket 02 sudah memutuskan bentuk kasarnya dan itu **premis, bukan bahan perdebatan lagi**: chunk bernomor sequence eksplisit (bukan mengandalkan urutan kedatangan), backpressure menumpuk di sisi Runner dengan cap lokal alih-alih menekan Postgres, blob append-only per attempt alih-alih baris DB, live-tail dan arsip-untuk-dicari diperlakukan sebagai dua masalah berbeda, dan UI satu tab per Key. Ticket 07 menambah batas transport: **tidak ada kanal persisten** — unggahan log adalah POST chunk lewat HTTP biasa, sama seperti `/claim` dan `/heartbeat`.

Yang tersisa:

1. **Kunci dan penomoran** — satu blob per apa? Ticket 14 memisahkan `turn` dari `attempt`, jadi percakapan 30 giliran menghasilkan 30 blob atau satu blob bersambung. Pilihan ini menentukan tampilan UI untuk step interaktif.
2. **Jalur live-tail** — pembaca di browser mendapat log yang belum selesai lewat apa: polling dari offset, SSE dari control plane, atau membaca blob store langsung. Control plane stateless (ticket 07) — jangan merusaknya di sini.
3. **Ack dan pengiriman ulang** — chunk yang belum di-ack dikirim ulang, jadi penerima harus idempoten terhadap sequence yang sama. Di mana dedup itu terjadi, dan berapa lama Runner menahan chunk yang belum di-ack sebelum menyerah.
4. **Runner mati membawa buffer** — chunk yang belum sempat diunggah hilang bersama mesinnya. Apakah itu diterima apa adanya (attempt-nya toh diulang) atau ada yang harus dijamin.
5. **Redaksi** — ticket 04 menyatakan redaksi log **bukan** kontrol utama dan tidak pernah dijamin. Jadi: apakah kita tetap meredaksi sebagai lapis kedua, di sisi Runner sebelum unggah atau di control plane, dan apa yang jadi daftar polanya.
6. **Retensi** — berapa lama log disimpan, dan apakah aturannya sama dengan Artifact (ticket 15) atau berbeda. Log StepRun yang `awaiting-human` berbulan-bulan tidak boleh kena GC berbasis "Run selesai".
7. **Ukuran** — owainlewis/factory memakai batas keras 10MiB per attempt; ticket 02 menggantinya dengan backpressure di laju. Apakah tetap ada batas atas, dan apa yang terjadi saat tercapai: potong, hentikan StepRun, atau biarkan.
8. **Pencarian** — arsip yang bisa dicari lintas Run adalah masalah terpisah yang Argo sendiri mengaku tidak memecahkannya. Apakah ia in scope, dan kalau ya, apa bentuk paling murahnya.

Zoom ke ticket 15: kalau Artifact memutuskan blob store, log menumpang di sana dan pertanyaan ini menyusut jadi soal kunci dan retensi saja.

**Diselesaikan ticket 15 — ini premis sekarang, bukan lagi pertanyaan**: blob store adalah **Garage**, satu bucket `factory` dengan prefix `log/`. Unggahan memakai presigned PUT langsung Runner→Garage, jadi control plane tidak pernah memegang byte log; pertanyaan 2 harus menghormati itu. Pola redaksi sudah dikunci sebagai **literal best-effort di Runner sebelum unggah** atas nilai yang Runner sendiri inject — pertanyaan 5 menyusut jadi "apakah log memakai pola yang sama atau lebih luas". Retensi Artifact adalah **umur, 90 hari sejak Run berakhir**; pertanyaan 6 tinggal memutuskan log ikut angka itu atau punya angkanya sendiri, dan kekhawatiran `awaiting-human` sudah tertangani karena ketiga pemicu retensi dipicu state Postgres, bukan umur objek.

## Answer

Ticket 15 memang menyusutkan ticket ini seperti yang diramalkan, tapi ia juga meninggalkan satu masalah yang tidak terlihat dari luar: **objek S3 tidak bisa dibaca sambil ditulis.** Live-tail di atas blob store presigned bukan soal memilih transport — ia soal menerima bahwa log yang belum selesai adalah **banyak objek**, bukan satu objek yang tumbuh.

### Satu blob per (StepRun, attempt); giliran gratis

Sub-pertanyaan 1 tertutup tanpa keputusan baru, tapi ia menuntut satu kalimat yang selama ini tersirat dinyatakan terang.

Ticket 14 menuliskan `turn` dan `attempt` sebagai dua kolom di `step_run`, dan ticket 15 membacanya sebagai **satu baris StepRun per giliran** — seluruh keputusan "riwayat PRD adalah `WHERE key='prd'` diurutkan menurut turn" berdiri di atas bacaan itu. Bacaan ticket 15 yang benar dan dipakai di sini: **giliran berikutnya melahirkan baris StepRun baru dengan `turn+1`, dan `attempt` menghitung ulang dari nol di dalam giliran itu.** Ini yang membuat "retry policy membaca `attempt` saja" (ticket 14) dan "retry menimpa baris yang sama" (ticket 06) keduanya benar sekaligus: retry menimpa baris giliran, giliran baru menambah baris.

Maka kunci log adalah **(StepRun, attempt)**, dan "per giliran" jatuh gratis:

```
log/<run-id>/<step-run-id>/a<attempt>/<seq>.chunk
```

Percakapan 30 giliran = 30 StepRun = 30 log terpisah, masing-masing punya tab-nya sendiri di bawah tab Key ticket 02. Tidak ada blob bersambung lintas giliran, dan tidak ada keputusan UI baru untuk step interaktif.

### Live-tail: long-poll dari offset, bentuk yang sama dengan `/claim`

Sub-pertanyaan 2 menyisakan tiga pilihan, dan dua di antaranya sudah gugur oleh premis sebelum ticket ini dibuka: SSE dari control plane melanggar "tidak ada kanal persisten" (ticket 07), dan membaca blob store langsung tidak bisa membaca objek yang sedang ditulis.

Yang tersisa dan yang dipilih: **polling dari offset**, dengan bentuk yang sudah ada di sistem ini:

```
GET /step-runs/:id/log?attempt=<n>&from=<seq>
  → menahan ≤30 detik sampai ada chunk baru
  → { chunks: [{ seq, url }], next: <seq>, sealed: bool }
```

`url` adalah presigned GET berumur pendek. Control plane mengembalikan **daftar URL, tidak pernah byte** — premis ticket 15 (control plane tak pernah memegang byte) berlaku untuk baca persis seperti untuk tulis. Long-poll ≤30 detik adalah bentuk `/claim` ticket 07 yang dipakai ulang; stateless, nol koneksi yang harus dipelihara, nol kode transport baru.

Arsip dibaca dengan endpoint yang **sama** dari `from=0`. "Live-tail dan arsip adalah dua masalah berbeda" (ticket 02) tetap benar sebagai pernyataan tentang *bentuk penyimpanan* — arsip adalah objek tersegel, live-tail adalah objek yang masih bertambah — tapi keduanya berbagi satu jalur baca.

### Chunk adalah objek terpisah, dan tidak pernah dikompaksi

Kompaksi ditolak, dan bukan karena malas:

- **Runner yang menggabungkan** — Runner boleh mati kapan saja, dan log dari Runner yang mati justru yang paling ingin dibaca.
- **Control plane yang menggabungkan** — ia harus mengunduh dan mengunggah byte, membatalkan premis ticket 15.
- **Multipart upload S3 sebagai kompaksi gratis** — menggoda dan **tidak bisa**: S3 menuntut tiap part ≥5MiB kecuali yang terakhir. Chunk log berukuran kilobyte.

Jadi chunk tetap objek terpisah selamanya. Flush **tiap 1 detik atau 256KiB, mana yang lebih dulu**; StepRun 10 menit menghasilkan ≤600 objek kecil, dan Garage tidak keberatan. Penghapusan retensi tetap satu operasi per prefix.

Yang dibayar: pembaca arsip mengambil N objek, bukan satu. Untuk StepRun panjang itu ratusan permintaan — diterima, karena membaca arsip penuh adalah tindakan jarang dan browser menjalankannya paralel.

### Ack, dedup, dan Runner yang menyerah

Sub-pertanyaan 3. Urutan per chunk:

1. Runner PUT ke Garage lewat presigned URL. **Idempoten secara bentuk** — key memuat `seq`, jadi kirim ulang menimpa dirinya sendiri dengan isi yang sama.
2. Runner POST `{ stepRunId, attempt, seq, bytes }` ke control plane. Upsert dengan primary key `(step_run_id, attempt, seq)`.

**Dedup terjadi di primary key**, bukan di kode. Ini bentuk yang sama dengan "upload dulu → catat metadata" ticket 15, dan invariannya juga sama: *baris chunk ada ⇒ objeknya pasti ada*.

Runner menahan chunk yang belum di-ack di memori dengan **cap 64MiB**; melewati cap, ia membuang yang **tertua** dan menyisipkan satu marker `[log dropped: N bytes]`. Membuang yang tertua dan bukan yang terbaru dipilih karena penyebab kegagalan hampir selalu ada di ujung akhir log, dan ujung akhir itu yang orang buka. Cap ini hanya pernah terisi kalau control plane tidak bisa dihubungi — unggahan ke Garage jalur terpisah dan tidak menunggu ack.

Runner menyerah **5 menit setelah StepRun berakhir**. Harganya dinyatakan: control plane mati lebih dari 5 menit tepat saat sebuah StepRun berakhir ⇒ ekor log StepRun itu ada di Garage tapi tidak terindeks, jadi tidak terbaca. Tidak ada rekonsiliasi yang memindai bucket — itu proses tambahan untuk memulihkan log dari satu skenario, dan log bukan data yang bernilai sebesar itu.

### Runner mati membawa buffer: diterima

Sub-pertanyaan 4. Diterima apa adanya, dan jendelanya kecil karena flush tiap 1 detik. Yang hilang paling banyak 1 detik terakhir.

Tidak ada yang dijamin, dan itu konsisten: ticket 15 sudah menetapkan bahwa **kegagalan unggah tidak menggagalkan StepRun**. Log punya status yang sama dengan Artifact — yang tidak dikonsumsi siapa pun boleh hilang; yang menggerakkan Graph adalah Output, dan Output tidak pernah lewat sini (ticket 23).

Satu catatan yang mudah terlewat: lease hilang ⇒ attempt baru (ticket 07), dan attempt baru punya prefix log sendiri. Log attempt yang mati **tidak ditimpa** — ia tetap bisa dibuka, dan justru itu yang dibutuhkan untuk memahami kenapa Runner-nya mati.

### Redaksi: pola yang sama persis, tidak lebih luas

Sub-pertanyaan 5 menyusut jadi satu pilihan, dan jawabannya **sama, tidak lebih luas**: literal best-effort di Runner sebelum unggah, atas nilai-nilai yang **Runner sendiri inject** (secret Project, token GitHub, master-key material). Satu daftar, satu implementasi, dipakai Artifact dan log.

Melebarkannya jadi pola regex — bentuk `sk-`, bentuk JWT, apa pun yang "terlihat seperti kunci" — ditolak. Ticket 04 sudah membawa buktinya: Buildkite meredaksi client-side dan tetap punya bug produksi, dan semua vendor menyatakan redaksi tidak dijamin. Daftar regex yang lebih panjang tidak membuat jaminannya membaik; ia cuma membuat orang percaya ada jaminan. Kontrol utamanya tetap default-deny egress (ticket 10).

Dinyatakan sekali lagi supaya tidak tergerus: **redaksi bukan kontrol keamanan.**

### Retensi: 30 hari, angkanya sendiri

Sub-pertanyaan 6. Log **tidak** ikut angka Artifact. **30 hari sejak Run berakhir**, dibanding 90 hari untuk Artifact.

Alasannya bisa dinyatakan dalam satu kalimat: log adalah mayoritas byte dan paling jarang dibaca ulang, sementara yang benar-benar ingin dibaca lagi setelah sebulan — diff dan transkrip percakapan — sudah dimaterialisasi jadi Artifact oleh ticket 15. Menyimpan log mentah 90 hari berarti membayar penyimpanan untuk salinan kedua dari sesuatu yang sudah punya bentuk yang lebih baik.

Pemicunya **state Postgres**, sama seperti ketiga kebijakan ticket 15, bukan lifecycle rule bucket. Maka kekhawatiran `awaiting-human` berbulan-bulan tertutup dengan sendirinya: Run belum berakhir ⇒ jam belum mulai berjalan. Ini kebijakan retensi **keempat**, dan ia tidak menambah mekanisme apa pun — satu baris lagi di sweep yang sudah ada.

### Batas ukuran: 256MiB per attempt, memotong tanpa menggagalkan

Sub-pertanyaan 7. Batas atas tetap ada, tapi angkanya bukan 10MiB.

10MiB milik owainlewis/factory dibuat untuk log perintah build. Satu agent yang bekerja 45 menit sambil mencetak diff dan hasil test bisa melewatinya sebelum separuh jalan, dan log yang terpotong di tengah pekerjaan adalah log yang tidak berguna. **256MiB per (StepRun, attempt)**, dan saat tercapai: berhenti mengunggah, sisipkan satu marker terakhir, **StepRun tetap jalan dan tetap boleh sukses.**

Menggagalkan StepRun karena lognya panjang berarti membuang pekerjaan yang benar karena keluarannya cerewet. Itu bertentangan dengan ticket 15, yang sudah menetapkan bahwa kegagalan permanen di jalur artefak tidak menggagalkan StepRun.

Dua mekanisme berbeda hidup berdampingan dan tidak boleh tertukar: **ring buffer 64MiB** menangani control plane yang tidak bisa dihubungi, **batas 256MiB** menangani Step yang mencetak tanpa henti. Yang pertama soal transport, yang kedua soal penyimpanan.

Backpressure di laju (ticket 02) tetap berlaku di atas keduanya: Runner yang tidak sanggup mengunggah secepat Step mencetak menumpuk di sisinya sendiri, tidak pernah menekan Postgres.

### Pencarian lintas Run: out of scope

Sub-pertanyaan 8. **Out of scope**, dan ini keputusan cakupan, bukan penundaan.

Argo mengakui tidak memecahkannya (ticket 02); memecahkannya berarti indeks teks penuh atas ratusan gigabyte — komponen infra kelima setelah control plane, web, Postgres, dan Garage, dengan cerita backup dan upgrade-nya sendiri. Destination map ini adalah spec siap implement untuk menjalankan pipeline, dan spec itu lengkap tanpa mesin pencari.

Bentuk termurahnya dicatat supaya tidak perlu dipikirkan ulang kalau destination berubah: log sudah jadi objek di Garage dengan prefix yang bisa ditebak, jadi pengindeks eksternal bisa dipasang tanpa satu pun perubahan di sini.

### Konsekuensi ke ticket lain

- **14 (closed)** — bacaan "satu baris StepRun per giliran" dinyatakan eksplisit sebagai bacaan yang berlaku, sesuai yang ticket 15 sudah pakai. Bukan keputusan baru; menutup ambiguitas yang skema dua-kolom ticket 14 tinggalkan.
- **15 (closed)** — pola "upload dulu → catat metadata" dan presigned dua arah dipakai ulang apa adanya. Kebijakan retensi bertambah dari tiga jadi empat, dengan pemicu state Postgres yang sama.
- **07 (closed)** — bentuk long-poll `/claim` dipakai ulang untuk jalur baca log. Control plane tetap stateless.
- **02 (closed)** — batas keras 10MiB diganti 256MiB, dengan alasan yang ditulis. Sisanya (chunk bernomor sequence, backpressure di Runner, blob per attempt, dua masalah terpisah, tab per Key) berlaku apa adanya.
- **04 (closed)** — redaksi ditegaskan ulang sebagai lapis kedua non-jaminan, tanpa pelebaran pola.
- **13 (open)** — panel log punya kontrak: satu tab per Key, di dalamnya satu bagian per giliran, endpoint long-poll tunggal untuk live dan arsip, marker `[log dropped]` dan `[log capped]` adalah dua keadaan yang harus punya tampilan.
- **17 (open)** — 30 giliran = 30 log terpisah, jadi "percakapan panjang" di layar grilling tidak bisa dijawab dengan satu panel log bergulir.
