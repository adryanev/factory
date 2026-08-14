# Model artefak: apa yang dihasilkan sebuah step, dan bagaimana ia diperiksa

Type: grilling
Status: resolved
Blocked by: 05

## Question

"Artefak" itu apa persisnya, disimpan di mana, dan apa artinya "inspect artefak tiap step" di layar?

Ini naik dari kabut jadi ticket karena kamu memintanya secara eksplisit. Ia juga jadi tulang punggung: PRD hasil grilling adalah artefak, diff hasil coding adalah artefak, dan keduanya harus bisa dibuka di UI yang sama.

1. **Daftar tipe** — buat daftar tertutup. Dugaan awal: diff/commit, transkrip percakapan agent, dokumen markdown (PRD, rencana), structured output JSON, output perintah (hasil test, lint), berkas biner (screenshot, build). Apakah tipe bisa ditambah tanpa mengubah skema?
2. **Penyimpanan** — keputusan "git remote jadi bus" sudah mencakup yang ter-commit. Yang tidak ter-commit tinggal di mana: kolom di Postgres, berkas di disk control plane, atau object store? Ingat constraint self-hosted — MinIO berarti satu komponen lagi yang harus dijalankan dan di-backup. Apakah batas ukuran memisahkan penyimpanan kecil dari besar?
3. **Artefak versus keluaran step** — ticket 05 sudah memutuskan apa yang mengalir di sepanjang DAG. Apakah artefak itu benda yang sama, atau artefak adalah hasil sampingan yang *tidak* mengalir dan hanya untuk dibaca manusia? Beda ini penting: yang mengalir harus punya kontrak, yang untuk dibaca tidak.
4. **Versi** — kalau manusia menyunting draf PRD di tengah step interaktif (ticket 14), apakah tiap suntingan jadi versi baru? Apakah riwayatnya bisa dilihat?
5. **Inspeksi di UI** — apa arti "inspect" untuk tiap tipe: markdown dirender, diff diwarnai, JSON diberi struktur, log bisa dicari, biner diunduh. Mana yang minimum dan mana yang bisa ditunda.
6. **Perpindahan** — worker menghasilkan artefak 200MB. Ia sampai ke control plane bagaimana, dan apa yang terjadi kalau gagal di tengah. Adakah artefak yang tidak pernah meninggalkan worker?
7. **Retensi dan kebocoran** — artefak memuat kode dan bisa memuat jejak secret. Berapa lama disimpan, siapa yang boleh membaca (menyambung ke ticket 11), dan bagaimana ia dihapus.
8. **Menautkan ke git** — untuk artefak yang berupa commit, apakah kita menyimpan salinan atau cukup menyimpan SHA dan nama branch lalu mengambilnya dari remote saat dibuka? Yang kedua jauh lebih hemat tapi bergantung pada remote tetap hidup dan branch tidak dihapus.

## Answer

Pertanyaan 3 tidak pernah dibuka: `CONTEXT.md` sudah memisahkan **Output** (mengalir, punya kontrak) dari **Artifact** (tertinggal, untuk dibaca) di ticket 05. Seluruh keputusan di bawah ini berdiri di atas pemisahan itu — dan satu di antaranya adalah konsekuensinya yang paling tajam.

### Artifact tidak punya kontrak, dan itu memindahkan beban ke Output

Runner melaporkan apa pun yang ia hasilkan. Step **tidak** mendeklarasikan daftar artefak yang wajib ada, dan control plane tidak menolak artefak yang tak terduga.

Godaannya adalah membuat Step mendeklarasikan `artifacts: [{ name: "prd", kind: "document" }]` supaya "step ini gagal menghasilkan PRD" terdeteksi. Itu ditolak karena mendua terhadap definisi di `CONTEXT.md`: begitu daftar artefak jadi kontrak, Artifact berhenti jadi "yang tertinggal untuk dibaca" dan mulai jadi Output kedua dengan aturan validasi sendiri. Kalau sebuah Step harus **menjamin** PRD ada, jaminan itu ditulis di skema Output-nya — di sana memang tempatnya, dan mekanismenya sudah ada.

Konsekuensi langsung yang harus ditulis eksplisit: **upload artefak yang gagal permanen tidak menggagalkan StepRun.** StepRun sukses selama Output-nya valid. Artefak yang hilang adalah kehilangan bahan bacaan, bukan kegagalan eksekusi.

### Immutable, satu per StepRun; riwayat sudah ada gratis

```
artifact
  id
  step_run_id          -- satu-satunya pemilik
  key                  -- slug ternormalisasi, UNIQUE (step_run_id, key)
  kind                 -- enum tertutup
  media_type           -- untuk header unduhan
  size_bytes
  blob_path            -- factory/artifact/<step_run_id>/<key>
  created_at
```

Tidak ada tabel versi. Manusia menyunting draf PRD di giliran 7 (ticket 14) → itu **Artifact baru milik StepRun giliran 7**, bukan versi kedua dari artefak giliran 6. "Riwayat PRD" adalah kueri `WHERE key = 'prd'` diurutkan menurut turn — riwayat yang sudah kita miliki cuma-cuma karena ticket 14 memberi satu StepRun per giliran.

Ini yang **membuka `edit-artifact` yang ditunda ticket 14 tanpa keputusan baru**: bentuk interaksi itu ditunda persis karena ia memaksa "Artifact punya versi" diputuskan di sana. Jawabannya ternyata tidak punya versi, jadi `kind` keempat bisa ditambahkan kapan saja secara aditif.

**Lubang yang diterima sadar**: stabilitas `key` lintas giliran adalah **konvensi, tidak ditegakkan**. Agent yang menulis `"PRD"` di satu giliran dan `"prd"` di giliran lain memutus rantai riwayat, dan tidak ada yang mengeluh. Mitigasi satu-satunya adalah normalisasi slug di control plane sebelum simpan. Menegakkannya lebih keras berarti menghidupkan lagi daftar artefak berkontrak yang baru saja ditolak.

Kepemilikan berhenti di StepRun. Artefak "ringkasan seluruh Run" dibuat oleh Step terakhir; kolom pemilik kedua yang nullable akan menggandakan tiap kueri dan tiap cek izin demi kasus yang sudah punya jalan keluar.

### Diff dimaterialisasi, dan itu yang menyelamatkan retensi

Ticket 02 memutuskan branch dihapus saat Run selesai. Menyimpan artefak diff sebagai **rujukan** (branch + SHA) karena itu cacat fatal: artefaknya mati persis pada momen orang mulai membacanya.

Jadi saat StepRun berakhir, diff **dimaterialisasi jadi blob**; SHA tetap disimpan sebagai metadata untuk yang mau menelusuri ke GitHub. Diff teks umumnya puluhan sampai ratusan KB — harganya murah, dan imbalannya besar: **branch jadi bebas dihapus**, yang melunasi lubang retensi yang ditinggalkan ticket 14.

### Penyimpanan: satu jalur, tanpa pengecualian

Blob store sudah tak terhindarkan sebelum ticket ini dibuka — ticket 02 menuntutnya untuk log, ticket 14 untuk session. Ticket ini menambah konsumen ketiga dan memutuskan bentuknya.

**Semua artefak ke blob.** Tidak ada jalur "kecil disimpan inline di Postgres". PRD 4KB tetap jadi objek. Ambang ukuran akan melahirkan dua jalur tulis, dua jalur baca, **dua jalur penghapusan**, dan dua tempat jejak secret bisa mengendap — dan retensi sudah jadi bagian tersulit ticket ini tanpa perlu digandakan.

**Satu bucket `factory`, tiga prefix**: `artifact/`, `log/`, `session/`. Satu kebijakan akses, satu backup. Retensi ditegakkan GC kita sendiri, bukan lifecycle rule bucket — pemicunya adalah state di Postgres yang tidak bisa diungkapkan sebagai aturan lifecycle apa pun (lihat di bawah). Efek sampingnya menguntungkan: nol ketergantungan pada fitur lifecycle engine mana pun.

### Engine: Garage, dan MinIO sudah mati

**Garage** (AGPL-3.0, single binary Rust, Deuxfleurs). Presigned PUT/GET dan ketujuh operasi multipart terkonfirmasi di matriks kompatibilitas resminya.

MinIO adalah default yang tidak diambil, dan riset menunjukkan itu keputusan yang tepat, bukan selera:

- Feb 2025 — web admin console dicabut dari Community Edition.
- **25 Apr 2026 — `minio/minio` diarsipkan.** README menyatakan "THIS REPOSITORY IS NO LONGER MAINTAINED". Tidak ada lagi biner CE terkompilasi, dan tidak akan ada patch AGPL berikutnya.
- Penerusnya, "MinIO AIStor Free", tunduk pada **EULA proprietary** — bukan AGPL — yang membatasi ke pemakaian single-node dan melarang modifikasi maupun redistribusi.

Gugur juga: SeaweedFS (Apache-2.0, aktif, tapi ada laporan cacat pada presigned yang dikombinasikan multipart), Zenko CloudServer (diposisikan sebagai alat dev/CI oleh pembuatnya sendiri), Ceph RGW (didesain untuk cluster; berlebihan untuk satu node), rclone serve s3 (berstatus "Experimental", presigned dilaporkan gagal 403), s3rver (diarsipkan, rilis terakhir 2021 — hanya untuk testing).

Catatan yang menghemat pekerjaan: 200MB masih di bawah batas single-PUT S3 (5GB), jadi multipart **bukan syarat**, hanya kenyamanan untuk resume.

### Perpindahan: presigned dua arah, control plane tidak pernah memegang byte

Runner meng-upload **langsung ke Garage** lewat presigned URL. Argumen penentunya bukan ukuran melainkan premis ticket 07: begitu control plane memproksi 200MB, ia berhenti stateless.

**Titik commit — upload dulu, catat metadata belakangan.** Ini meniru invarian ticket 14 (*Question ada ⇒ ref dan session pasti ada*) dan menghasilkan pasangannya:

> **Baris Artifact ada ⇒ blob pasti ada.**

Mati di tengah menghasilkan blob yatim, yang dibersihkan GC. Urutan sebaliknya menghasilkan baris yang menunjuk blob tak ada, dan memaksa UI memiliki state "sedang diunggah" dan "gagal selamanya" — dua state untuk membeli apa yang urutan benar berikan gratis.

Multipart dipakai di atas 8MB supaya 200MB yang putus bisa dilanjutkan. Presigned GET di-mint control plane **setelah cek izin**, berumur **5 menit**; URL yang bocor membuka jendela 5 menit tanpa cek izin ulang, dan itu diterima sebagai harga dari control plane yang tetap stateless.

**Tidak ada artefak yang tinggal di Runner.** Kalau tidak ter-upload, ia bukan Artifact — ia file di sandbox yang mati bersama sandbox. Kelas `local-only` yang cuma dicatat namanya hanya akan mengisi UI dengan entri yang tak bisa dibuka siapa pun.

**Kuota**: 1GB per artefak, 5GB per StepRun, **ditolak saat presigned URL diminta** — bukan setelah 200MB terlanjur naik.

### Retensi: tiga konsumen, tiga kebijakan

Peringatan ticket 02 "jangan hapus berdasarkan umur" berlaku untuk **branch**, dan menerapkannya ke Artifact justru merusak: artefak akan menguap tepat saat Run selesai, yaitu saat orang mulai membacanya.

| Konsumen blob | Pemicu penghapusan |
|---|---|
| **Artifact** | umur — default **90 hari sejak Run berakhir**, dapat diatur per Project |
| **Branch** | Run berakhir (ticket 02, tidak berubah) |
| **Session** | StepRun tidak lagi `awaiting-human` **dan** Run berakhir |

Ini **melunasi kabut "retensi branch dan blob percakapan yang menggantung"** dari ticket 14. Percakapan yang menggantung berbulan-bulan tidak punya Run yang berakhir, jadi tidak ada satu pun dari ketiganya yang dihapus — dan itu sekarang perilaku yang disengaja, bukan lubang. Yang membuatnya aman adalah materialisasi diff: branch boleh hilang tanpa artefak ikut hilang.

Ketiga pemicu membaca state di Postgres, bukan umur objek. Itu sebabnya GC ditulis sendiri dan lifecycle rule bucket tidak dipakai.

### Membaca dan kebocoran

Izin baca artefak = **izin baca Project** dari ticket 11 (`admin`/`member`). `owner` org **tidak** otomatis dapat — ia harus menambahkan dirinya jadi anggota, dan itu teraudit. Tidak ada superuser diam-diam, konsisten dengan ticket 11.

**Redaksi literal best-effort di Runner sebelum upload**: nilai secret yang Runner sendiri inject diganti `***`. Ini pencocokan literal atas nilai yang Runner tahu persis, bukan penebakan pola. Dua kalimat yang wajib menyertainya:

1. Ini **bukan** kontrol keamanan. Ticket 04 sudah menetapkan redaksi tidak pernah jadi kontrol utama, dan bahkan vendor yang meredaksi client-side punya bug produksi nyata. Kontrol utamanya tetap default-deny egress (ticket 10) dan siapa yang boleh membaca.
2. Karena Artifact immutable, **redaksi harus terjadi sebelum upload**. Tidak ada jalan memperbaikinya belakangan selain menghapus artefaknya.

### Inspeksi di UI

| Wajib sekarang | Ditunda |
|---|---|
| `document` → markdown dirender | diff side-by-side |
| `diff` → unified, diwarnai | syntax highlighting per bahasa |
| `command-output` → plaintext + cari | preview gambar inline |
| `binary` → unduh saja | pencarian lintas artefak |
| `transcript` → dirender sebagai markdown | viewer transcript khusus |
| `structured` → JSON pretty-print | JSON tree/collapse |

Keenam yang wajib memakai pustaka jadi — nol desain baru. Semua yang ditunda bersifat aditif dan tidak mengubah skema.

`kind` adalah **enum tertutup** (`diff`, `transcript`, `document`, `structured`, `command-output`, `binary`) supaya UI bisa dijamin lengkap — pola yang sama dengan tiga `kind` tertutup di ticket 14. `media_type` berdiri di sampingnya hanya untuk header unduhan, tidak pernah memilih renderer. Menambah tipe = satu nilai enum + satu renderer, tanpa migrasi skema.

### Konsekuensi ke ticket lain

- **18** — log menumpang blob store yang sama (`factory/log/`), engine Garage, dan pola presigned yang sama. Ketergantungan yang ticket 02 catat sudah lunas. Sekarang unblocked.
- **17** — mewarisi `edit-artifact` yang kini bisa dibangun tanpa keputusan baru, dan kontrak renderer untuk transcript dan document. Sekarang unblocked.
- **16** — PRD tetap artefak markdown milik sebuah StepRun, bukan entitas produk tersendiri; kalau ticket 16 mau memutuskan sebaliknya, ia harus melawan pemisahan Output/Artifact secara eksplisit. Sekarang unblocked.
- **13** — punya bentuk konkret untuk dirender di panel artefak per StepRun. Masih diblokir ticket 06.
- **14** — lubang retensi yang ditinggalkannya sudah ditutup di sini.
- **02** — cabang "kalau ticket 15 memutuskan sebaliknya, keputusan log harus ditinjau ulang" tidak diambil; rekomendasi log berdiri utuh.
- **Packaging self-host** — Garage jadi komponen infra keempat yang harus dijalankan, di-backup, dan diupgrade, bersama control plane, web, dan Postgres.
