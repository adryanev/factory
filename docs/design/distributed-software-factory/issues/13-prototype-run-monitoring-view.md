# Prototype: tampilan monitoring run yang sedang berjalan

Type: prototype
Status: resolved
Assignee: adryanev
Blocked by: 06, 15

## Question

Sebuah run yang sedang berjalan itu terlihat seperti apa di layar — dan apa yang sebenarnya ingin dilihat orang ketika ia membukanya?

Monitoring adalah setengah dari permintaan awal, tapi "monitoring" masih terlalu kabur untuk dispesifikasikan. Bikin sesuatu yang bisa direaksi.

Bangun prototype UI sekali pakai (React + Vite, data palsu, tanpa backend) untuk pipeline acuan `plan → {agent A, B, C} → pick-best → test` dalam keadaan sedang berjalan, dengan A selesai, B berjalan, C gagal.

Yang harus dijawab lewat prototype, bukan lewat diskusi:

1. **Tampilan utama** — grafik DAG, daftar step, atau timeline? Grafik terlihat menarik tapi sering kalah berguna dibanding daftar begitu step bertambah banyak. Buat lebih dari satu dan bandingkan.
2. **Live log** — tiga agent mencetak bersamaan. Apakah log ditampilkan digabung, atau satu panel per cabang? Bagaimana user berpindah tanpa kehilangan posisi. Apa yang terjadi saat log sangat panjang.
3. **Kepadatan informasi** — apa yang tampil tanpa perlu klik: worker mana yang mengerjakan tiap step, sudah berjalan berapa lama, nama branch, dan token/biaya terpakai sejauh ini.
4. **Tindakan** — tombol apa yang ada saat run berjalan: cancel seluruh run, cancel satu cabang, retry step yang gagal. Di mana letaknya supaya tidak tertekan tanpa sengaja.
5. **Keadaan gagal** — bagaimana C yang gagal ditampilkan, dan seberapa cepat orang bisa sampai ke penyebabnya. Ini keadaan yang paling sering dibuka, jadi jangan dianggap kasus pinggiran.
6. **Halaman daftar** — sebelum layar ini, ada layar berisi banyak run. Apa yang tampil di sana.

Simpan di `docs/design/distributed-software-factory/prototypes/monitoring-ui/` dan tautkan dari sini. Sekali pakai — yang kita ambil adalah keputusannya, bukan kodenya.

**Keadaan yang wajib ada di prototype, dari ticket 06** — semuanya sudah diputuskan, jadi ini bahan, bukan pertanyaan:

- Simpul placeholder **"menunggu fan-out"** untuk cabang yang belum lahir. Graph dimaterialisasi hibrida, jadi layar ini harus menunjukkan bentuk Run sebelum cabangnya ada.
- State **`skipped`** yang berbeda tampilannya dari `failed` — ia bukan kegagalan, dan ia menyebar ke hilir.
- **Run `succeeded` yang memuat cabang `failed`** (Join `any`). Ini bukan kasus pinggiran; kalau UI menampilkannya sebagai kontradiksi, keputusan ticket 06 tidak tersampaikan.
- Penanda **"tersumbat menunggu manusia"**: satu cabang `awaiting-human` bisa menahan Join `all` selamanya, dan cancel adalah satu-satunya jalan keluar. Orang harus bisa melihat sumbatnya dari layar ini.
- StepRun yang **tidak terjadwal > 5 menit** (tidak ada Runner cocok) ditandai.
- **`attempt` dan `turn` adalah dua penomoran** (ticket 14). Pertanyaan 5 soal keadaan gagal harus menunjukkan attempt keberapa tanpa mengaburkan giliran keberapa.

Panel artefak per StepRun memakai renderer yang sudah dikunci ticket 15 (markdown, diff unified berwarna, plaintext + cari, unduh).

---

**Prototype ada**: [`prototypes/monitoring-ui/index.html`](../prototypes/monitoring-ui/index.html) — satu berkas, tanpa build, tanpa dependency. Buka langsung di browser.

Menyimpang dari "React + Vite" yang diminta ticket: prototype ini vanilla HTML/JS satu berkas. Alasannya operasional — ia harus bisa dibuka dengan satu perintah tanpa `pnpm install`, dan yang diambil dari ticket ini adalah keputusannya, bukan kodenya.

Bahan tambahan yang masuk setelah ticket ini ditulis: simpul Step control-plane tanpa Runner dan tanpa log (ticket 24), biaya berjalan **selagi Run berjalan** dan label "tidak didukung" alih-alih nol (ticket 20), marker `[log dropped]`/`[log capped]` dan tab log per Key berisi bagian per giliran (ticket 18), kolom "tersumbat" di halaman daftar (ticket 19), dan pemicu Run beserta cron yang dilewati (ticket 22).

Prototype menyimpan tiap alternatif sebagai sakelar hidup di **bilah keputusan** di dasar layar — delapan sumbu, dari tata letak turun ke notasi terkecil. Nilai yang tersetel sebagai bawaan adalah jawaban di bawah ini; sakelarnya sengaja dibiarkan hidup supaya alternatif yang kalah tetap bisa dilihat, bukan hanya dibaca.

---

## Answer

Delapan sumbu dibolak-balik langsung di layar. Tujuh mendarat di rekomendasi; satu dibalik, dan justru yang dibalik itu yang paling berkonsekuensi.

### 1. Tampilan utama: **Graph** yang jadi bawaan

Daftar direkomendasikan dan kalah. Alasan yang menang: pertanyaan pertama yang dibawa orang ke layar ini bukan "step mana yang mana", tapi **"kenapa Run ini belum selesai"** — dan itu pertanyaan tentang *bentuk*, bukan tentang daftar. Fan-out, Join yang menunggu, cabang yang belum lahir, dan hilir yang tak akan pernah dijadwalkan hanya terbaca sebagai bentuk. Daftar dan Timeline tetap ada sebagai tab, tidak dihapus.

Harga pilihan ini nyata dan dibayar di muka, bukan ditemukan nanti: ticket 06 mengizinkan fan-out **dinamis tanpa batas**, jadi 50 cabang boleh terjadi, dan 50 kartu adalah dinding, bukan bentuk. Maka satu aturan ikut terkunci bersama pilihan ini:

> Kotak fan-out **meringkas** begitu cabangnya lebih dari delapan. Yang digambar adalah delapan cabang teratas menurut urutan **`failed` → `awaiting` → `unsched` → `running` → sisanya**, lalu satu baris `…42 cabang lain` yang membuka Daftar tersaring ke fan-out itu.

Urutannya bukan selera: yang ditampilkan lebih dulu adalah yang menahan Run. Peringkasan yang mengurut menurut Key akan menyembunyikan satu-satunya cabang yang gagal di balik empat puluh yang sehat, dan itu membuat bawaan graph berbohong tepat pada kasus yang paling sering dibuka.

Daftar tetap satu-satunya tampilan yang tidak melebar, dan Timeline tetap satu-satunya yang menjawab *menunggu itu berapa lama*. Keduanya kalah sebagai **bawaan**, bukan sebagai tampilan.

### 2. Detail StepRun: **panel kanan tetap**

Konteks Run dan detail satu Step terlihat bersamaan, dan lompat antar cabang tidak membuang apa pun — yang persis dituntut pertanyaan 2 ("bagaimana user berpindah tanpa kehilangan posisi"). Panel bawah kalah karena vertikal adalah sumbu yang paling dibutuhkan log. Halaman tersendiri kalah karena tiap lompatan cabang menuntut navigasi balik.

Konsekuensi yang dinyatakan: **tidak ada URL per StepRun**. Membagikan tautan ke satu kegagalan berarti membagikan tautan Run plus menyebut nama Step-nya. Menambahkan `?step=<key>` yang menyeleksi panel adalah aditif murni — satu parameter dibaca saat mount — dan tidak dibangun sekarang.

### 3. Live log: **satu panel per cabang**

Ini bukan sekadar selera tampilan; ia menegaskan bentuk penyimpanan ticket 18. Kunci log adalah **(StepRun, attempt)** dan tidak ada objek gabungan di Garage. Aliran gabungan karenanya harus dirakit di klien, dan urutan lintas cabangnya hanya sebenar jam masing-masing Runner — tiga mesin berbeda, tanpa jam bersama. Itu **angka yang terlihat benar padahal bukan**, kelas yang sama persis dengan estimasi biaya yang ticket 20 tolak. Ditolak dengan alasan yang sama.

Posisi scroll disimpan per cabang, jadi berpindah dan kembali tidak melempar orang ke ujung. Log panjang tetap memakai bentuk ticket 18: bagian per giliran, marker `[log dropped]` dan `[log capped]` tampil sebagai baris, bukan disembunyikan.

### 4. Sumbatan: **banner satu kalimat di atas tampilan utama**

Sumbatan tidak boleh menuntut orang membaca Graph dulu. Satu banner, satu kalimat, satu tombol keluar. Aturan yang mengikat isinya:

> Banner hanya untuk keadaan yang **menahan Run**: `awaiting-human` yang menyumbat Join, dan StepRun tak terjadwal >5 menit. Kegagalan yang tidak menahan apa pun — cabang `failed` di bawah Join `any` — **tidak** naik jadi banner.

Batas itu yang menjaga keputusan ticket 06 tersampaikan. Run yang masih bergerak tidak boleh dipasangi spanduk merah hanya karena satu cabang mati, kalau tidak "Run `succeeded` memuat cabang `failed`" akan terbaca sebagai kontradiksi persis seperti yang ticket ini larang.

### 5. Status: **ikon berbentuk + teks**, bukan pill

Tiap state punya bentuk sendiri — cakram bercentang, cincin berputar, cincin jeda, cincin putus tergores, cincin berjarum jam. **Warna tidak pernah jadi satu-satunya pembeda.** Varian titik-warna dibangun justru supaya bisa ditolak sambil melihat: dengan titik saja, `skipped` dan `failed` hanya berbeda rona, padahal keduanya adalah pasangan yang ticket 06 paling khawatirkan tertukar. Pill kalah karena tujuh state jadi tujuh kapsul berwarna di satu tabel — dekorasi yang menuntut mata mengurai, bukan memindai.

### 6. Kepadatan: **lega**

Rapat menang di layar 12 baris dan kalah di layar 12 baris yang salah satunya gagal: baris catatan yang menjelaskan *kenapa* adalah hal pertama yang dibuang mode rapat, dan itu tepat isi pertanyaan 5.

### 7. Notasi giliran: **panjang** — `giliran 4 · attempt 1`

Satu-satunya rekomendasi yang dibalik, dan pembalikan ini menopang keputusan yang sudah dikunci di tempat lain. Ticket 14 dan 18 bersusah payah menyatakan bahwa **turn dan attempt adalah dua penomoran terpisah** dengan aturan yang berbeda: `attempt` dibaca retry policy dan menghitung ulang di dalam tiap StepRun, `turn` tidak. Menyingkatnya jadi `t4·a1` mengubah dua konsep yang tidak boleh tertukar menjadi dua huruf yang mirip, berdampingan, dalam satu font. Notasi yang paling sering dibaca tidak boleh jadi tempat penghematan enam karakter.

`t4-a1` **tetap hidup di satu tempat**: nama branch `run/<run-id>/<key>/t4-a1`, karena di sana ia bukan singkatan — ia literal, dan orang menyalinnya ke `git checkout`.

Konsekuensi tampilan: kolom giliran di Daftar melebar dari 9% ke 15%, dan di kartu Graph notasi ini hanya muncul kalau `turn > 1` atau `attempt > 1` — aturan yang sudah berlaku sebelumnya dan sekarang jadi yang menahan biaya lebarnya. Hanya angka **attempt** yang berwarna merah saat >1; angka turn tetap netral, karena giliran ke-4 bukan gejala apa pun sementara attempt ke-2 selalu gejala.

### Yang tidak dijadikan varian, dan kenapa

**Tindakan (pertanyaan 4)** tidak pernah masuk bilah keputusan, karena penempatannya bukan selera: "Batalkan Run" di kanan atas dengan konfirmasi yang menyebut **apa yang akan hilang** (StepRun mana yang mati, giliran ke berapa yang dibuang, apa yang tetap tersimpan) — bukan "Anda yakin?"; "Batalkan cabang" hanya di dalam panel cabang yang bersangkutan; "Jalankan ulang" hanya di dalam kotak kegagalan, dekat sebabnya. Tidak ada tombol destruktif bersebelahan dengan tombol utama di mana pun.

**Kepadatan informasi (pertanyaan 3)** juga tidak divariasikan, karena daftarnya sudah ditentukan ticket lain: Runner, durasi berjalan, biaya berjalan (ticket 20), notasi giliran, dan satu baris **alasan** — `butuh exec:host, macos` / `attempt 2/2 habis · output-invalid` / `menyumbat hilir · ditanyakan ke reviewer`. Nama branch sengaja **tidak** ada di kartu Graph karena ia selalu lebih panjang dari kartunya; ia ada di Daftar dan di tab Info.

**Halaman daftar (pertanyaan 6)** memakai kolom **Tersumbat** sebagai alasan keberadaannya — "apa yang menunggu manusia" terjawab tanpa membuka satu Run pun, yang membayar janji ticket 19. Run `succeeded` membawa catatan `1 cabang gagal · join any`. Cron yang dilewati (ticket 22) tampil sebagai baris, bukan hilang diam-diam. Chip **batas bawah** menandai biaya tak lengkap, bukan `$0.00`.

### Keadaan wajib ticket 06 — semuanya tampil dan sudah dinilai

Simpul `docs` **belum lahir** digambar putus-putus di posisinya; `verify · agent-c` **dilewati** memakai tanda tergores dan dipudarkan, tidak pernah merah; Run `succeeded` dengan cabang `failed` ada di halaman daftar sebagai #1039 dengan catatannya; `review` **tersumbat** jadi satu-satunya simpul bertinta dan satu-satunya yang naik jadi banner; `lint` **tak terjadwal 7m 30s** ditandai tapi tetap antre, bukan gagal; `agent-c` menunjukkan attempt ke-2 tanpa mengaburkan giliran ke-1.
