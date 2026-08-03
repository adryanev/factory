# Step yang dieksekusi control plane

Type: grilling
Status: resolved
Blocked by: 06, 07, 16

## Question

Ticket 16 memperkenalkan `kind: pull-request` — Step yang punya `after:`, `attempts`, dan `outcome` seperti Step lain, tapi **tidak pernah diklaim Runner**. `/claim` ticket 07 tidak akan pernah mengembalikannya. Siapa yang menjalankannya, dan dengan jaminan apa?

Bentuknya sudah punya preseden: `awaiting-human` ticket 14 juga StepRun tanpa lease. Tapi preseden itu cuma soal *menunggu* — tidak ada yang perlu dieksekusi. Ini yang pertama harus benar-benar dikerjakan control plane sendiri.

1. **Siapa yang menjalankan** — sweep periodik yang sudah ada di ticket 07 memungut StepRun `ready` berjenis control-plane, atau jalur terpisah. Kalau ada beberapa proses control plane, apa yang mencegah dua-duanya mengeksekusi StepRun yang sama. Ticket 07 sudah punya jawaban untuk masalah bentuk ini — query leasing dengan partial unique index — dan pertanyaannya apakah mekanisme itu dipakai ulang atau ini butuh yang lebih ringan.
2. **Timeout dan attempt** — ticket 06 mengunci satu jam dipegang control plane dan `attempts: 2` sebagai default. Panggilan API GitHub berdurasi detik, jadi angka itu jelas salah untuk jenis ini. Apakah jenis Step ini punya angkanya sendiri, dan apakah kegagalan jaringan menghabiskan `attempt` yang sama dengan kegagalan validasi Output.
3. **Idempotensi** — control plane mati setelah GitHub membuat PR tapi sebelum barisnya ditulis. Attempt berikutnya membuka PR kedua dari branch yang sama. Ticket 15 memakai pola "upload dulu → catat metadata" untuk masalah bentuk yang sama; di sini urutannya tidak bisa dibalik, jadi butuh jawaban lain — GitHub menolak PR duplikat untuk pasangan head/base yang sama, dan apakah itu cukup dijadikan sandaran.
4. **Restart saat berjalan** — StepRun control-plane yang sedang dieksekusi lalu control plane restart. Tanpa lease dan heartbeat, tidak ada yang mendeteksi ia menggantung. Sweep ticket 07 mengurus lease yang hilang; jenis ini tidak punya lease untuk hilang.
5. **Apakah jenisnya tertutup** — `pull-request` satu-satunya untuk sekarang, atau ini titik ekstensi. Kalau tertutup, ia enum kecil dan tiap anggota ditulis tangan. Kalau terbuka, ia mulai jadi kerangka plugin, dan itu harga yang jauh lebih besar. YAGNI menyarankan tertutup dengan satu anggota, tapi ticket 09 menyatakan `steps:` adalah mapping bernama dengan bidang eksplisit, jadi bentuk penulisannya di YAML perlu diputuskan bersama ini.
6. **Cancel** — ticket 06 mengunci cancel lewat heartbeat → SIGTERM ke process group. Tidak ada process group di sini. Membatalkan Run saat StepRun control-plane sedang berjalan berarti apa.
7. **Tampilan di Graph** — ticket 13 akan merender Graph yang memuat simpul tanpa Runner, tanpa log Sandbox, dan tanpa Artifact. Apa yang ditampilkan sebagai gantinya, dan apakah kegagalannya terbaca sama jelasnya dengan kegagalan Step agent.

Rekomendasi awal untuk diuji: pakai ulang kueri leasing ticket 07 dengan lease pendek alih-alih menciptakan mekanisme kedua, jenis Step tertutup dengan satu anggota, dan sandarkan idempotensi pada penolakan PR duplikat GitHub daripada membangun kunci idempotensi sendiri.

**Ditambahkan oleh ticket 23** — dua muatan, dan yang kedua adalah sub-pertanyaan baru.

Sisi **konsumsi** beres: `{ title, body }` untuk `kind: pull-request` sekarang dua field level atas Output hulu, dirujuk dengan bentuk data `{ step, output }` yang sama seperti `branchesFrom`, dan ikut pemeriksaan statis saat validasi definisi. Yang tersisa untuk ticket ini cuma memutuskan apakah rujukannya ditulis eksplisit atau tersirat dari `after:`.

Sisi **produksi** jadi lubang: ticket 23 mengunci **`outputs:` hanya boleh ditulis Step ber-agent** — Step `run:` dikecualikan karena ekstraksi Output adalah mekanisme agent yang dipinjam dari sandcastle. Step control-plane jatuh di sisi yang sama: ia tidak punya stdout agent dan tidak pernah memanggil `run()`. Jadi kalau `kind: pull-request` perlu memancarkan sesuatu ke hilir — URL PR, nomor PR — jalurnya belum ada, dan pilihannya harus diputuskan di sini: Output dibangun langsung oleh control plane tanpa lewat ekstraksi (bentuknya tetap dideklarasikan `outputs:`, tapi pengisinya kode kita), atau `kind: pull-request` memang dinyatakan daun yang tidak pernah punya hilir. Yang kedua lebih murah dan mungkin benar — ticket 16 sudah menempatkan PR sebagai batas kepemilikan factory — tapi ia harus dinyatakan, bukan terjadi diam-diam.

## Answer

Ketiga rekomendasi awal bertahan, dan yang pertama bertahan karena **alasan yang berbeda dari yang ditulis di muka**: lease dipakai ulang bukan demi menghindari mekanisme kedua, melainkan karena lease adalah satu-satunya hal yang menjawab sub-pertanyaan 4.

### Lease bukan untuk menjadwalkan, tapi untuk mendeteksi mati

Sub-pertanyaan 1 dan 4 terlihat seperti dua masalah dan sebenarnya satu. Sub-pertanyaan 1 bertanya apa yang mencegah dua proses control plane mengeksekusi StepRun yang sama; sub-pertanyaan 4 bertanya siapa yang mendeteksi StepRun control-plane yang menggantung karena control plane-nya restart. Mekanisme apa pun yang lebih ringan dari lease — misalnya `SELECT ... FOR UPDATE SKIP LOCKED` yang dilepas saat koneksi putus — menjawab yang pertama dan meninggalkan yang kedua terbuka, karena tidak ada yang tertinggal di baris untuk menyatakan "seseorang sedang mengerjakan ini sejak kapan".

Maka: **kueri leasing ticket 07 dipakai ulang apa adanya**, dengan lessee berupa id instance control plane, bukan id Runner. Partial unique index yang sudah jadi benteng terakhir di sana tetap jadi benteng terakhir di sini. Dan sweep lease kedaluwarsa ticket 07 — yang sudah ada, sudah dijalankan, dan sudah diuji — memungut StepRun control-plane yang menggantung **tanpa satu baris kode baru**. Sub-pertanyaan 4 lunas sebagai efek samping.

Yang berbeda dari Runner: **tidak ada heartbeat.** Panggilan API GitHub berdurasi detik, jadi lease pendek berjangka **60 detik** tanpa perpanjangan sudah cukup — ia tidak pernah perlu bertahan lebih lama dari pekerjaan yang dijaganya. Lease yang lewat 60 detik berarti control plane-nya mati di tengah, dan itu memang yang ingin dideteksi.

`/claim` ticket 07 menyaring `kind IS NULL` (Step biasa), jadi Runner tidak akan pernah melihat StepRun jenis ini. Sweep control-plane menyaring kebalikannya. Satu kueri, dua pemanggil, dua filter.

### Angka sendiri, dan tidak satu pun ditulis di YAML

Ticket 06 mengunci timeout satu jam dan `attempts: 2` untuk Step yang dijalankan Runner. Untuk panggilan API berdurasi detik, angka itu bukan cuma salah — ia berbahaya: StepRun yang menggantung satu jam karena satu request tersangkut menahan hilirnya selama satu jam.

Angka untuk `kind: pull-request`:

```
timeout   60s     -- satu percobaan, bukan seluruh Step
attempts  3
backoff   5s tetap, kecuali GitHub mengirim Retry-After (dipatuhi apa adanya)
```

Ketiganya **milik jenisnya, bukan milik penulis Pipeline**. `timeout:` dan `attempts:` adalah bidang yang skema tolak pada Step ber-`kind:`. Alasannya sama dengan alasan ticket 23 menolak `maxRetries` di YAML: angka yang tidak punya keputusan di baliknya cuma memberi penulis kesempatan menuliskannya salah.

Sub-pertanyaan 2 juga bertanya apakah kegagalan jaringan memakan `attempt` yang sama dengan kegagalan lain. **Ya — satu penghitung**, konsisten dengan ticket 07 (lease hilang memakan jatah yang sama) dan ticket 23 (`output-invalid` memakan `attempt` biasa). `reason` dicatat terpisah supaya "3× gagal karena 401" terbaca berbeda dari "3× gagal karena timeout", tapi penghitungnya tetap satu. Dua penghitung adalah persis bentuk yang ticket 02 peringatkan.

### Idempotensi bersandar ke GitHub, dan sandaran itu diperiksa dulu

Sub-pertanyaan 3 benar bahwa urutan "tulis dulu → catat metadata" ticket 15 tidak bisa dibalik di sini: PR sudah ada di dunia sebelum kita sempat mencatatnya.

Jawabannya **tidak membangun kunci idempotensi sendiri**, dengan dua lapis yang keduanya milik GitHub:

1. Sebelum membuat, `GET /repos/{owner}/{repo}/pulls?head={owner}:{branch}&base={base}&state=open`. Kalau sudah ada, **adopsi** — catat nomor dan URL-nya, StepRun sukses. Attempt kedua setelah crash mendarat di sini.
2. Kalau lomba tetap terjadi (dua attempt beririsan), `POST /pulls` mengembalikan **422** untuk pasangan head/base yang sudah punya PR terbuka. 422 itu diperlakukan **sukses**, lalu ulangi langkah 1 untuk mengambil nomornya.

Apakah sandaran ini cukup? Ya, dan batasnya bisa dinyatakan: jaminan GitHub berlaku untuk PR **terbuka** pada pasangan head/base yang sama. Kalau PR-nya sudah ditutup manusia, langkah 1 tidak menemukannya dan langkah 2 tidak menolak — kita membuka PR kedua dari branch yang sama. Itu keadaan yang benar, bukan duplikat: seseorang menutup PR, sistem mencoba lagi, PR baru muncul. Yang mustahil terjadi adalah **dua PR terbuka bersamaan** dari branch yang sama, dan itu satu-satunya duplikat yang merugikan.

Harga yang dibayar sadar: satu panggilan API tambahan per attempt.

### Jenis tertutup, satu anggota, dan bentuknya di YAML

Sub-pertanyaan 5: **tertutup.** `kind:` adalah bidang Step dengan enum satu anggota. Bukan titik ekstensi, bukan kerangka plugin.

```yaml
open-pr:
  after: [implement]
  kind: pull-request
  base: main # bawaan: default branch repo
  title: { step: implement, output: prTitle }
  body: { step: implement, output: prBody }
```

Yang skema tolak pada Step ber-`kind:`: `agent:`, `prompt:`, `promptFile:`, `run:`, `outputs:`, `runsOn:`, `attempts:`, `timeout:`, `branches:`, `branchesFrom:`, dan seluruh bidang HITL (`ask:`, `onReject:`, `humanTimeout:`, `onHumanTimeout:`). Daftar penolakan yang panjang itu justru bukti bahwa jenisnya memang tertutup: kalau ia titik ekstensi, tidak satu pun dari penolakan ini bisa ditulis.

`after:` tetap wajib dan tetap eksplisit (ticket 09), dan ia yang memberi Ref — branch mana yang jadi kepala PR. Karena `after:` menunjuk Step ber-fan-out, Step ini ikut lahir per cabang (ticket 16), sehingga PR-per-repo ticket 21 terjadi tanpa aturan tambahan.

Membuka jenis ini nanti tetap aditif: satu anggota enum lagi, satu handler lagi. Yang mahal adalah membangun kerangkanya sekarang untuk satu anggota, dan itu yang ditolak.

### Rujukan `{ title, body }` ditulis eksplisit

Muatan ticket 23 dijawab: **eksplisit**, bentuk `{ step, output }` yang sama dengan `branchesFrom`.

Tersirat-dari-`after:` ditolak dengan alasan yang sudah dua kali dipakai di map ini: ia membuat `after:` menjawab dua pertanyaan — "apa yang harus selesai dulu" dan "dari mana judul PR diambil" — dan itu bentuk yang sama dengan akar bug `continueOn` Argo (ticket 02) dan alasan ticket 09 menolak `after:` implisit. Tambahan lagi, `after:` boleh memuat lebih dari satu Step, jadi bentuk tersirat langsung ambigu pada Join.

Pemeriksaan statisnya gratis dan sudah dibangun ticket 23: Step yang dirujuk wajib punya `outputs:` yang mendeklarasikan `prTitle` dan `prBody` sebagai `string`.

### `kind: pull-request` adalah daun

Sub-pertanyaan baru dari ticket 23 dijawab: **daun. Ia tidak pernah punya hilir.** `after:` yang menunjuk sebuah Step ber-`kind:` adalah error validasi.

Alasannya bukan sekadar "lebih murah". Ticket 16 menempatkan PR sebagai batas kepemilikan — factory memiliki segalanya sebelum PR ada, GitHub sejak PR ada. Sebuah Step hilir yang memakai URL PR menurut definisi bekerja **setelah** batas itu, dan permukaan tulis factory sudah dihentikan di dua izin (`contents:write` + `pull_requests:write`), jadi apa pun yang ingin dilakukan hilir — komentar, label, review request — tidak punya izin untuk melakukannya.

Membangun jalur "control plane mengisi `outputs:` sendiri tanpa ekstraksi" berarti membuat **implementasi kedua** atas aturan yang ticket 23 baru saja tolak untuk Step `run:` dengan alasan yang persis sama. Dua implementasi satu aturan adalah kelas drift senyap yang ticket 12 sudah membayar contract test untuknya.

Nomor dan URL PR tetap dicatat — di **baris StepRun**, bukan sebagai Output. Ia tampil di UI dan di halaman Run, dan itu yang membuat sub-pertanyaan 4 ticket 21 (PR saudara saling ditemukan) bisa dijawab tanpa jalur baru.

Harganya dinyatakan: "buka PR lalu kirim URL-nya ke suatu tempat" tidak bisa ditulis sebagai Pipeline. Kalau nanti dibutuhkan, jalurnya adalah menyatakan bahwa control plane boleh mengisi `outputs:` untuk jenis Step yang ia jalankan sendiri — aditif, satu cabang di validator, dan keputusannya sudah dirumuskan di sini.

### Cancel: tidak ada yang diinterupsi

Sub-pertanyaan 6. Tidak ada process group, jadi pola SIGTERM ticket 06 tidak berlaku — sama seperti `awaiting-human` ticket 14 di mana cancel cuma penulisan baris DB.

Aturannya: **flag cancel Run diperiksa tepat sebelum panggilan tulis ke GitHub.** StepRun yang belum di-lease tidak pernah mulai. StepRun yang sudah di-lease tapi belum memanggil `POST /pulls` berhenti di situ. StepRun yang sudah memanggilnya dibiarkan selesai — durasinya detik, dan mengabaikan respons berarti membuka PR yang tidak pernah kita catat, yang lebih buruk daripada mencatatnya lalu menandai Run cancelled.

Sisa jendelanya dinyatakan: cancel yang tiba dalam milidetik antara pemeriksaan flag dan respons GitHub tetap menghasilkan PR terbuka pada Run yang berstatus cancelled. Itu terbaca di UI (Run cancelled, StepRun succeeded, PR ada) dan tidak butuh pemulihan — PR bisa ditutup manusia.

### Tampilan di Graph

Sub-pertanyaan 7, sebagai bahan untuk ticket 13 — bukan keputusan UI, tapi daftar apa yang **tidak** ada dan apa penggantinya:

| Step biasa | `kind: pull-request` |
| --- | --- |
| Runner yang mengerjakan | "control plane" |
| Tab log Sandbox | tidak ada tab log |
| Panel Artifact | nomor + URL PR, atau body error GitHub |
| `attempt` dan `turn` | `attempt` saja, `turn` selalu 1 |
| Durasi menit–jam | detik |

Kegagalannya harus terbaca sama jelasnya: **body respons GitHub disimpan sebagai `reason` StepRun** dan ditampilkan di tempat yang sama dengan pesan gagal Step lain. Ini satu-satunya diagnostik yang ada, jadi ia tidak boleh disembunyikan di balik klik.

### Konsekuensi ke ticket lain

- **23 (closed)** — kedua muatannya lunas. Sisi konsumsi: rujukan eksplisit. Sisi produksi: jalurnya **tidak dibangun**, dan `kind: pull-request` dinyatakan daun — dinyatakan, bukan terjadi diam-diam, seperti yang ticket 23 minta.
- **07 (closed)** — kueri klaim menerima satu filter (`kind IS NULL` untuk `/claim`), dan sweep-nya menerima satu pemanggil kedua. Nol mekanisme baru.
- **06 (closed)** — angka timeout/attempts satu jam & 2 dinyatakan **hanya berlaku untuk Step yang dijalankan Runner**. Bukan koreksi, cuma batas yang belum pernah ditulis.
- **21 (resolved)** — dikonfirmasi dua arah: Step ini lahir per cabang dan punya repo, sehingga "PR di banyak repo" bukan pelanggaran aturan satu-repo, dan keputusan daun di sini yang membuat PR saudara ditemukan lewat halaman Run alih-alih lewat Output.
- **16 (closed)** — `kind: pull-request` sekarang punya mekanik lengkap. Nol koreksi terhadapnya.
- **13 (open)** — tabel di atas adalah bahan render; simpul tanpa Runner dan tanpa log bukan lagi pertanyaan terbuka.
