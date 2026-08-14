# Cost dan token tracking

Type: grilling
Status: resolved
Blocked by: —

## Question

Angka token dan biaya datang dari mana, dicatat per apa, dan diagregasi bagaimana?

Digraduasi dari kabut setelah ticket 01 (permukaan sandcastle) dan ticket 10 (kepemilikan credential) selesai. Ticket 10 sudah menjawab separuh pertanyaan atribusi, jadi sisanya bisa dirumuskan tajam.

Yang sudah dikunci dan jadi premis:

- **Attribusi selalu ke Principal pemicu**, terlepas credential siapa yang dipakai — ticket 10 memisahkan tegas "siapa yang memicu" dari "kunci siapa yang dipakai", dan melarang keduanya dijawab satu kolom.
- Fallback User→ServiceAccount lewat `allowSharedAgentCredential` berarti biaya sebuah Run bisa jatuh ke kunci Project sementara pemicunya seorang User. Kedua fakta itu harus tetap terbaca terpisah.
- Ticket 01 menemukan cost tracking sandcastle **hanya token mentah, dan hanya untuk dua agent**. Sisanya kesenjangan yang harus kita isi.
- Tulisan berfrekuensi tinggi — potongan log, heartbeat, **progres token** — menulis langsung ke StepRun **di luar** transaksi penjadwalan (ticket 05), supaya Runner yang cerewet tidak memblokir scheduler.

Yang harus diputuskan:

1. **Sumber angka** — token mentah dari sandcastle untuk dua agent yang didukung; agent lain memberi apa? Apakah kita menerima bahwa sebagian agent tidak punya angka sama sekali, dan bagaimana itu ditampilkan (kosong, perkiraan, atau "tidak didukung")?
2. **Token ke uang** — harga per model hidup di mana. Tabel yang dikelola operator, atau di-hardcode dan ikut rilis? Harga berubah dan run lama tidak boleh berubah nilainya secara retroaktif.
3. **Granularitas** — dicatat per StepRun, per giliran (ticket 14 memisahkan `turn` dan `attempt`), atau per panggilan agent? Retry dan giliran ganda berarti satu Step bisa punya banyak angka.
4. **Agregasi** — per Run, per Pipeline, per Project, per Principal, per rentang waktu. Mana yang benar-benar dilihat orang, dan mana yang cuma terdengar berguna?
5. **Batas dan rem** — apakah ada kuota yang bisa menghentikan Run yang membakar terlalu banyak? Kalau ya, siapa yang menyetelnya dan apa yang terjadi pada StepRun yang sedang jalan saat batas terlampaui. Kalau tidak, katakan sekarang bahwa satu Run yang liar bisa menghabiskan kredit tanpa dihentikan sistem.
6. **Retensi** — angka biaya jauh lebih kecil daripada log. Apakah ia bertahan lebih lama dari Run yang melahirkannya, dan apa yang terjadi saat Run dihapus?
7. **Siapa boleh melihat** — biaya per Principal adalah data yang sensitif secara sosial di dalam tim. `member` melihat biaya seluruh Project, atau hanya miliknya sendiri? Zoom ke ticket 11.

Zoom ke ticket 01 untuk apa yang sandcastle sebenarnya berikan, dan ke ticket 10 untuk model attribusi.

## Answer

Dua aturan yang membentuk seluruh jawaban, dan keduanya tentang **menolak angka yang terlihat benar**: angka yang tidak ada tidak pernah diperkirakan, dan angka yang sudah ditulis tidak pernah dihitung ulang.

### Angka yang tidak ada tidak diperkirakan

Sub-pertanyaan 1. Ticket 01 menemukan cost tracking sandcastle hanya token mentah dan hanya untuk dua agent. Untuk sisanya: **kosong, dan ditulis sebagai "tidak didukung".**

Estimasi ditolak — menghitung token dari panjang prompt, memakai tokenizer pihak ketiga, memakai rata-rata historis. Semuanya menghasilkan angka yang **terlihat seperti pengukuran** padahal tebakan, dan angka semacam itu akan dijumlahkan ke laporan bulanan lalu dipakai orang untuk mengambil keputusan. Kolom kosong yang jujur lebih berguna daripada angka yang salah dengan cara yang tidak terlihat.

Konsekuensi yang harus diterima terang-terangan: **total biaya sebuah Project adalah batas bawah, bukan total.** UI menuliskannya begitu — "biaya dari N StepRun; M StepRun memakai agent tanpa data usage". Kalau ini jadi menyakitkan, obatnya bukan estimasi melainkan memilih agent yang melaporkan usage, dan angka itu yang membuat pilihannya bisa diambil.

Ticket 12 relevan di sini dan sudah membayar harganya: provider host sengaja didaftarkan `tag: "bind-mount"` alih-alih `tag: "none"` justru karena `none` mematikan session capture secara senyap dan **ticket 20 kehilangan `usage`**. Jadi jalur angka untuk `exec:host` sudah diamankan sebelum ticket ini dibuka.

### Harga dibekukan saat tulis

Sub-pertanyaan 2, dan ini bagian yang paling mudah dibuat salah.

Harga hidup di tabel yang **dimiliki operator**, di-seed lewat migrasi dan diperbarui operator saat vendor mengubah harga:

```
model_prices(model, input_per_mtok, output_per_mtok,
             cache_write_per_mtok, cache_read_per_mtok,
             effective_from, version)
```

Hard-code yang ikut rilis ditolak: harga model berubah lebih sering daripada kita merilis, dan mengikat perubahan harga ke upgrade sistem berarti angka salah selama berminggu-minggu.

Yang menjawab kekhawatiran retroaktif bukan tabelnya, melainkan **kapan perkaliannya terjadi**: `cost_usd` **dihitung sekali, saat StepRun berakhir, lalu disimpan di barisnya** bersama `price_version` yang dipakai. Tidak ada tampilan yang mengalikan token dengan harga saat ini. Run bulan lalu bernilai apa yang ia bernilai bulan lalu, selamanya, dan `price_version` yang tersimpan membuat angka itu bisa dijelaskan kalau ada yang bertanya.

Tanpa UI untuk mengelola harga. Operator menyunting tabel; membangun layar untuk sesuatu yang berubah beberapa kali setahun adalah YAGNI.

### Granularitas: per StepRun, kumulatif lintas attempt

Sub-pertanyaan 3. Dicatat **per StepRun**. Per panggilan agent tidak tersedia — sandcastle melaporkan `usage` di akhir `run()`, bukan per panggilan — jadi pilihannya tidak pernah nyata.

Karena giliran melahirkan baris StepRun baru (ticket 14 sebagaimana dibaca ticket 15 dan ditegaskan ticket 18), **per giliran jatuh gratis**: percakapan 30 giliran punya 30 angka, dan "giliran mana yang mahal" terjawab tanpa kolom tambahan.

Bagian yang menuntut keputusan: **retry menimpa baris yang sama** (ticket 06). Kalau `tokens_in`/`tokens_out`/`cost_usd` ditimpa bersama barisnya, attempt pertama yang gagal setelah membakar 40 menit token **menghilang dari catatan biaya** — padahal itu uang yang benar-benar keluar. Maka:

> Angka biaya **ditambahkan, tidak pernah di-reset**, saat attempt baru berjalan di atas baris yang sama. `attempts_counted` disimpan di samping supaya "mahal karena panjang" terbaca beda dari "mahal karena diulang".

Ini satu-satunya kolom di `step_run` yang berperilaku kumulatif, dan ia harus begitu karena satu-satunya hal yang tidak bisa di-rollback oleh retry adalah uang.

Ditulis **di luar transaksi penjadwalan** (premis ticket 05), sejalur dengan potongan log dan heartbeat.

### Agregasi: tiga, dan hanya tiga

Sub-pertanyaan 4. Yang dibangun:

1. **Per Run** — di halaman Run, di samping durasi. Ini yang paling sering dilihat, dan konteksnya sudah ada di layar.
2. **Per Project per bulan** — pertanyaan "berapa yang kita habiskan".
3. **Per Principal per bulan** — pertanyaan "ke mana perginya".

Ditolak: per Pipeline (menarik didengar, tapi tidak ada tindakan yang mengikutinya), rentang waktu bebas, grafik tren, ekspor. Semuanya bisa ditambahkan belakangan dari data yang sama.

Tanpa tabel rollup. Ketiganya kueri agregat langsung di atas `step_runs` join `runs`; jumlah baris di sini diukur dalam puluhan ribu per bulan untuk satu tim internal, bukan jutaan. Menambahkan rollup sebelum ada pengukuran melanggar aturan performa map ini sendiri — ukur dulu, dan bekas untuk mengukurnya sudah ada.

### Dua kolom, karena ticket 10 melarang satu

Ticket 10 memisahkan tegas "siapa yang memicu" dari "kunci siapa yang dipakai" dan melarang keduanya dijawab satu kolom. Bentuk konkretnya di `runs`:

```
triggered_by_principal_id   -- attribusi; selalu terisi
credential_principal_id     -- pemilik kunci yang benar-benar dipakai
```

Untuk Run biasa keduanya sama. Untuk Run yang jatuh ke `allowSharedAgentCredential`, yang pertama seorang User dan yang kedua ServiceAccount Project. Untuk Run yang dipicu Automation keduanya ServiceAccount.

**Agregasi per Principal memakai kolom pertama.** Biaya jatuh ke pemicunya, sesuai premis ticket 10, apa pun kunci yang dipakai. Kolom kedua ada supaya pertanyaan "kunci Project ini terpakai untuk apa saja" tetap bisa dijawab — dan supaya `allowSharedAgentCredential` yang dinyalakan diam-diam terlihat sebagai selisih antara dua agregat.

### Tanpa kuota, tanpa rem, dan itu dinyatakan

Sub-pertanyaan 5 meminta kejujuran kalau jawabannya tidak, dan jawabannya **tidak**:

> Sebuah Run yang liar dapat membakar kredit sampai habis, dan sistem ini tidak akan menghentikannya.

Yang ada cuma pembatas tidak langsung: timeout satu jam per StepRun (ticket 06), `attempts: 2`, dan `slots` per Runner (ticket 07) yang membatasi berapa banyak agent berjalan sekaligus. Tidak ada satu pun yang melihat angka dolar.

Kuota ditolak sekarang karena setiap bentuknya menuntut angka yang belum ada — batas per Run, per Project per bulan, per Principal — dan menuntut jawaban atas "apa yang terjadi pada StepRun yang sedang jalan saat batas terlampaui" yang jawabannya buruk di semua cabang: membunuh di tengah membuang pekerjaan yang hampir selesai, membiarkan lewat membuat batasnya bohong. Menebak angka lalu membangun mekanisme penegakan di atas tebakan itu adalah urutan yang salah.

Yang **dibangun** sebagai gantinya, dan ini yang membuat penolakan di atas bisa dipertanggungjawabkan: biaya berjalan tampil **di halaman Run selagi Run berjalan**, bukan hanya setelah selesai. Orang yang membuka Run yang mengamuk melihatnya, dan tombol cancel sudah ada di layar yang sama. Pemicu untuk membuka lagi: tagihan mengejutkan pertama, yang akan datang membawa angkanya sendiri.

### Retensi: seumur baris Run

Sub-pertanyaan 6. Angka biaya hidup **di baris `step_runs` dan `runs`, yang tidak punya kebijakan retensi.** Log kedaluwarsa 30 hari (ticket 18), Artifact 90 hari, Branch saat Run berakhir (ticket 15) — biaya tidak pernah.

Itu memang gunanya: sebuah StepRun berumur setahun yang lognya sudah lama hilang tetap bisa menjawab berapa ia menghabiskan. Ukurannya beberapa puluh byte per baris; membuang data sekecil itu tidak membeli apa pun.

Konsekuensi yang dinyatakan: menghapus sebuah Project menghapus Run-nya dan **mengubah total historis** — agregat adalah kueri, bukan angka tersimpan, jadi laporan bulan lalu berubah setelah penghapusan. Diterima. Alternatifnya adalah tabel rollup yang bertahan setelah induknya hilang, dan itu membangun mesin akuntansi untuk tim internal yang tidak menagih siapa pun.

### Siapa boleh melihat: `member` melihat semuanya

Sub-pertanyaan 7. **`member` melihat seluruh biaya Project, termasuk rincian per Principal.**

Ticket 11 hanya punya `admin` dan `member` per Project, dan menolak peran ketiga dengan alasan yang berlaku di sini juga: memisahkan hak menurut kepekaan sosial berarti menghidupkan lagi gradasi peran yang baru saja ditolak.

Yang lebih menentukan: **agregat ini tidak menambah satu pun fakta baru.** Seorang `member` sudah bisa membuka Run mana pun di Project-nya, melihat siapa yang memicunya, dan melihat token yang terpakai — itu keputusan ticket 15 (baca Artifact = izin Project) dan ticket 11. Menyembunyikan penjumlahannya adalah privasi yang cuma menghalangi orang jujur, sambil menuntut kasus khusus di lapisan otorisasi yang ticket 11 rancang untuk tidak punya kasus khusus (`Principal` argumen eksplisit di tiap fungsi baca).

Kepekaan sosialnya nyata dan tidak disangkal; ia dijawab oleh cara menampilkan, bukan oleh izin — angka disajikan sebagai pemakaian per Principal di dalam konteks Project, tanpa peringkat dan tanpa urutan menurun sebagai bawaan.

`owner` org tetap **tidak** otomatis melihat data Project (ticket 11); ia harus menambahkan dirinya jadi anggota, dan itu teraudit.

### Konsekuensi ke ticket lain

- **10 (closed)** — dua kolom attribusi jadi bentuk konkret di `runs`. Larangan "satu kolom untuk dua pertanyaan" dipatuhi.
- **06 (closed)** — "retry menimpa baris yang sama" diberi satu pengecualian yang dinyatakan: kolom biaya kumulatif, tidak pernah di-reset. Ini satu-satunya kolom yang berperilaku begitu.
- **12 (closed)** — pilihan `tag: "bind-mount"` untuk provider host dikonfirmasi dari sisi ini; tanpanya `exec:host` tidak punya angka sama sekali.
- **11 (closed)** — nol peran baru, nol kasus khusus di lapisan otorisasi.
- **18 (resolved)** — biaya sengaja hidup lebih lama dari log dan Artifact. Empat kebijakan retensi ditambah satu yang eksplisit "tidak pernah".
- **13 (open)** — halaman Run menampilkan biaya berjalan **selagi berjalan** (bukan hanya setelah selesai), dan StepRun beragent tanpa `usage` menampilkan "tidak didukung", bukan nol. Keduanya syarat, bukan usulan.
