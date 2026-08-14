# Kontrak API web ↔ control plane

Type: grilling
Status: resolved
Blocked by: 25

## Question

Permukaan ini belum pernah disentuh ticket mana pun. Prototype 13 dan 17 memutuskan bentuk **layar** — Graph sebagai bawaan, panel kanan tetap, berdampingan, kotak teks yang tidak pernah hilang — dan sengaja tidak menyentuh apa yang mengalir di baliknya. Ticket 11 memutuskan siapa boleh melihat apa. Yang di antara keduanya belum ada.

1. **Gaya permukaan.** tRPC, REST plus OpenAPI dari Zod, atau Hono RPC. Yang membuat ini bukan selera adalah ticket 11: `Principal` argumen **eksplisit** di tiap fungsi baca, ditegakkan tipe, karena context ambient ditolak dengan alasan mode kegagalannya diam. Gaya yang dipilih harus membuat "lupa memeriksa izin" gagal saat compile, bukan saat review — dan tiga kandidat itu tidak sama kuat di titik ini. Pertanyaan turunannya: apakah pemeriksaan izin duduk di lapisan transport atau di fungsi domain yang transport panggil.

2. **Sesi browser, dan hubungannya dengan PAT.** Ticket 11 mengunci login GitHub OAuth, satu akun break-glass lokal, dan PAT sendiri (`sf_`, SHA-256, izin = izin pemiliknya, 90 hari). Yang belum: apakah PAT berlaku di permukaan yang sama dengan browser atau permukaan terpisah, dan apa yang dipakai browser — cookie sesi atau bearer di memori. Akun break-glass ada justru supaya pemadaman GitHub tidak mengunci kita keluar dari tombol cancel, jadi jalur loginnya harus tidak menyentuh GitHub sama sekali, dan itu kendala pada bentuk sesi.

3. **Kesegaran, dan apakah alasan ticket 07 mengikat di sini.** Ticket 07 menolak WebSocket/SSE untuk Runner demi menjaga control plane stateless; ticket 18 mengunci live-tail log sebagai long-poll dari offset yang mengembalikan daftar presigned GET dan tidak pernah byte. Pertanyaannya: apakah browser memakai endpoint yang sama itu, dan apakah penolakan WebSocket ikut terbawa ke browser atau alasannya tidak berlaku di sini. Ini menentukan bagaimana halaman monitoring ticket 13 memperbarui Graph — poll seluruh Run tiap N detik (sederhana, dan mahal persis pada Run fan-out 50 yang paling ingin ditonton), atau sesuatu yang lebih sempit.

4. **Byte tidak pernah lewat control plane, termasuk ke browser.** Ticket 15 mengunci presigned GET 5 menit **setelah cek izin**, dan premis 07 melarang control plane memegang byte. Konsekuensi yang belum diputuskan: browser mengambil Artifact dan log langsung dari Garage, jadi CORS di bucket adalah bagian kontrak ini, dan URL presigned yang sudah terbit tetap hidup 5 menit setelah izin dicabut — dinyatakan, atau diperpendek.

5. **Lencana, dan berapa sering ia ditanya.** Ticket 19 mengunci lencana sebagai kueri, bukan tabel, dan itu keputusan penopang di sana: "batalnya notifikasi" lunas tanpa satu baris kode justru karena tidak ada state yang bisa basi. Harganya jatuh ke sini — setiap tab terbuka menanyakannya berulang. Interval, dan apakah lencana ikut respons endpoint lain alih-alih punya endpoint sendiri.

6. **Menjawab Question.** Ticket 14 mengunci jawaban pertama menang lewat compare-and-set, penjawab selalu dicatat, dan Question ditujukan ke audiens bukan individu. Bentuk responsnya saat kalah balapan diputuskan di sini — dan ticket 17 menaikkan taruhannya: layar grilling menampilkan draf yang tumbuh sambil dibicarakan, jadi kalah balapan berarti layar penjawab harus berubah di depan matanya, bukan sekadar menampilkan error. Termasuk di sini: `edit-artifact` yang dibuka ticket 15, dan suntingan langsung di draf yang ticket 17 kunci.

7. **Editor pipeline sebagai generator PR.** Ticket 08 mengunci arahnya visual → kode, hasilnya PR, dan scope UI terkunci di situ. Endpoint-nya menulis ke GitHub — tapi ticket 16 mengunci permukaan tulis factory berhenti di dua izin (`contents:write` dan `pull_requests:write`), dan ticket 10 mengunci token di-mint per giliran untuk StepRun. Editor bukan StepRun dan tidak punya giliran. Atas nama Principal mana PR editor dibuka, dan token mana yang dipakai — ini pertanyaan yang tidak punya jawaban tersedia di ticket mana pun.

8. **Tombol yang sudah dijanjikan prototype.** Cancel Run (13), rewind (17, bentuknya sudah dikunci ticket 06 sebagai Run baru ber-`parent_run_id`), pemicu manual sebagai pengganti trigger komentar (22), dan sakelar `automation_enabled` per Project (22). Keempatnya menulis, jadi keempatnya butuh bentuk request, aturan izin, dan jejak audit ticket 11.

9. **Daftar, filter, dan agregasi.** Ticket 20 mengunci tepat tiga agregasi dan tanpa tabel rollup sampai terukur; ticket 19 mengunci halaman "Menunggu saya" diurutkan umur. Bentuk paginasi dan filter diputuskan di sini bersama indeks ticket 25 — keduanya satu keputusan yang dilihat dari dua sisi.

10. **Penolakan izin terlihat seperti apa.** Ticket 11 mengunci `owner` org **tidak** otomatis dapat akses data Project. Maka ada kelas nyata "kamu owner dan tetap tidak boleh melihat ini", dan responsnya harus membedakan tidak-ada dari tidak-boleh — atau dengan sengaja tidak membedakannya, dengan alasan.

Rekomendasi awal untuk diuji: satu permukaan tipe-aman dengan `Principal` sebagai parameter pertama fungsi domain (transport cuma memanggilnya), sesi cookie untuk browser dan PAT hanya di endpoint yang sama lewat header berbeda, poll pendek untuk Graph sampai terbukti mahal, dan editor pipeline membuka PR atas nama User yang menekan tombol — bukan ServiceAccount.

## Answer

Dua premis yang dibawa user di tengah sesi membunuh satu keputusan ticket 11 dan membalik keputusan ticket ini sendiri satu kali penuh. Sisanya jatuh dari fakta yang sudah terkunci di tempat lain.

### Premis 1 — PAT tidak punya konsumen, jadi PAT mati

Sub-pertanyaan 2 menanyakan apakah PAT berlaku di permukaan yang sama dengan browser. Jawabannya tidak terjawab melainkan **larut**: seluruh map disapu, dan `sf_` tidak pernah dirujuk satu ticket pun di luar jawaban ticket 11 yang melahirkannya. Empat kandidat pemanggil diperiksa dan keempatnya gugur:

- **Break-glass** (ticket 11) — login password lokal, justru dirancang tidak menyentuh GitHub. Bukan PAT.
- **ServiceAccount** (ticket 10, 19) — Principal yang *memiliki* credential dan dipakai control plane secara internal saat webhook memicu Run. Tidak pernah mengetuk API dari luar.
- **Pemicu manual** (ticket 22) — ticket itu sudah memutuskan penggantinya tombol UI, bukan perintah.
- **Setup / provisioning** (ticket 28) — compose, GitHub App manifest flow, migrasi one-shot. Nol panggilan API.

**Koreksi ke ticket 11: PAT `sf_` dihapus.** Yang ikut terhapus lebih besar dari satu tabel — kedaluwarsa 90 hari, `last_used_at` di UI, kewajiban penamaan supaya bisa dicabut yang tepat, dan satu kelas credential yang bisa bocor. Semuanya dibayar untuk nol pemanggil. Menghidupkannya kembali murni aditif: satu tabel, satu cabang di verifikasi auth, satu halaman UI. Jenis kejadian audit **#9 "Terbitkan PAT" ikut gugur**.

### Premis 2 — mobile Compose Multiplatform, dan pembalikan yang dinyatakan

Sub-pertanyaan 1 dibuka dengan dugaan bahwa tRPC / REST+OpenAPI / Hono RPC "tidak sama kuat" terhadap tuntutan ticket 11. **Dugaan itu salah**, dan membunuhnya lebih berharga daripada menjawabnya: tidak satu pun dari ketiganya bisa membuat "lupa memeriksa izin" gagal saat compile **di lapisan transport**. `protectedProcedure` tRPC memberi `ctx.principal` yang sudah terotentikasi tapi tidak pernah memaksa resolver *memakainya* — `protectedProcedure.query(() => db.select().from(runs))` lolos compile, dan itu persis mode kegagalan diam yang ticket 11 tolak.

Maka pemeriksaan izin **tidak boleh duduk di transport**, apa pun transportnya:

> Fungsi domain menerima `Principal` sebagai argumen pertama, dan tabel hanya bisa dicapai lewat fungsi-fungsi itu. Transport adalah lapisan tipis yang memanggil.

Dengan itu sub-pertanyaan 1 berhenti jadi keputusan keamanan, dan pemenangnya ditentukan hal lain. Di situ sesi ini berbalik dua kali, dan urutannya ditulis karena pembalikannya bukan karena argumen baru melainkan **premis yang hilang**:

1. Dengan PAT mati, klien tinggal browser — satu commit, satu image (ticket 28), skew nol secara konstruksi. Argumen terkuat ticket 26 (dokumen kontrak yang bisa dibaca tanpa TypeScript) tidak terbawa. **tRPC sempat menang.**
2. User menyatakan mobile menyusul, ditulis dengan **Compose Multiplatform** — Kotlin. tRPC bukan protokol, ia binding TypeScript; klien Kotlin berarti mem-parsing bentuk wire tRPC dengan tangan. **tRPC gugur.**

**Vonis: REST + Zod → OpenAPI dibangkitkan, sama dengan ticket 26.** Satu gaya, satu control plane, satu bentuk error, satu cara memasang middleware.

Dan nilai OpenAPI di sini **bukan** yang ditulis ticket 26. Bukan supaya manusia bisa membaca kontrak tanpa TypeScript — melainkan supaya **klien Kotlin dibangkitkan dari dokumen yang sama, bukan ditulis tangan**. React tetap dapat tipe ujung-ke-ujung lewat klien TS yang juga dibangkitkan dari Zod yang sama, jadi tidak ada yang hilang dengan membuang tRPC.

Efek samping yang layak dicatat: pilihan **Hono vs Fastify** yang menggantung sejak Notes map jadi **tidak berkonsekuensi**. Kedua permukaan REST di atas Zod yang sama; framework tinggal selera implementor.

### Sesi: cookie sekarang, bearer menyusul, dan satu garis yang harus ditulis

**Cookie `httpOnly`, `Secure`, `SameSite=Lax`**, sesi baris di Postgres (ticket 11). Bearer di memori JS ditolak: ia menuntut refresh token yang berakhir disimpan di cookie juga, hilang tiap reload tab, dan satu-satunya yang ia beli — kebal CSRF — bisa dibeli jauh lebih murah. Argumen XSS tidak membedakan keduanya: penyerang yang bisa menjalankan JS di origin kita tinggal memanggil API-nya langsung.

Bentuknya mirip sesuatu yang ticket 11 tolak, jadi garisnya ditulis eksplisit supaya tidak dibaca sebagai pelanggaran:

> Ambient boleh untuk **otentikasi** (siapa kamu). Tidak pernah untuk **otorisasi** (boleh apa) — di situ `Principal` tetap argumen eksplisit.

Harga cookie ambient dibayar sekarang, bukan ditemukan nanti: **CSRF jadi nyata** karena permukaan ini punya endpoint tulis. Pertahanannya `SameSite=Lax` + kewajiban satu header non-sederhana di tiap panggilan (`content-type: application/json` memicu preflight dan tidak bisa dipalsukan form HTML). Nol token CSRF, nol tabel.

**Break-glass** (ticket 11) dapat form password lokal di route terpisah yang menghasilkan **cookie yang sama persis**. Sesi tidak pernah tahu ia lahir dari OAuth atau password; yang membedakan cuma `audit_log`.

**Mobile mendapat bearer nanti**, dan itu satu cabang di verifikasi: baca dari cookie, kalau tidak ada baca dari header. Sesi sudah baris di Postgres, jadi nol tabel baru. Ini tidak menahan apa pun dan sengaja tidak dibangun sekarang.

### Kesegaran: tiga jalur, dan alasan ticket 07 sengaja tidak dipinjam

Sub-pertanyaan 3 menduga penolakan WebSocket ticket 07 mungkin terbawa. **Tidak terbawa**, dan meminjamnya akan jadi alasan yang salah: ticket 07 menolak WS karena control plane tidak boleh pernah *menginisiasi* ke Runner di balik NAT. Browser juga outbound-only. Alasannya tidak berlaku, jadi SSE harus ditolak atas alasannya sendiri.

```
Graph    → poll 3 detik + ETag   (baris step_runs Run yang sedang dibuka)
Log      → long-poll ≤30s dari offset → daftar presigned GET   (ticket 18, apa adanya)
Lencana  → menumpang respons kedua-duanya, nol endpoint dan nol interval sendiri
```

**Log tidak butuh SSE, dan itu fakta bukan selera.** Ticket 18 mengunci Runner flush chunk **tiap 1 detik atau 256KiB**, jadi data log memang hanya ada di granularitas 1 detik — lebih segar dari itu tidak ada yang bisa dikirim, apa pun transportnya. Endpoint-nya sudah menahan ≤30 detik dan balas seketika saat chunk mendarat: itu bukan polling, itu push dengan mekanik HTTP. Ticket 13 mengunci satu tab log per Key di panel kanan tetap, jadi satu tab browser = satu koneksi menggantung, dan kekhawatiran batas koneksi per origin tidak pernah terjadi.

**3 detik untuk Graph**, dengan ETag sehingga Run yang tidak bergerak menjawab `304` tanpa badan. Angkanya ditentukan satu momen saja — menekan Cancel lalu menunggu layar mengakuinya — bukan oleh kecepatan step, yang berdurasi menit.

**Lencana menumpang, dan itu melunasi sub-pertanyaan 5 tanpa keputusan terpisah.** Ticket 19 mengunci lencana sebagai kueri; kalau ia punya endpoint dan interval sendiri, tiap tab membayar dua timer untuk satu angka. Tab yang tidak sedang membuka Run memakai satu poll lambat ~30 detik yang isinya cuma lencana.

Ditolak, dan ini satu-satunya bentuk di mana WebSocket sungguh menang: **satu koneksi mengangkut Graph + log + lencana sekaligus**, menggantikan tiga poll. Harganya lapisan koneksi stateful, format amplop pesan, dan cerita reconnect-dengan-offset — menulis ulang apa yang HTTP sudah berikan gratis — lalu dibayar sekali lagi di Compose Multiplatform.

### Byte langsung dari Garage: hostname sendiri, dan pencabutan yang bukan penarikan

Ticket 15 mengunci control plane tidak pernah memegang byte, dan itu berlaku ke browser persis seperti ke Runner.

Bentuk yang menggoda — Garage satu origin di belakang reverse proxy ticket 28 (`https://factory.example/blob/*`), CORS lenyap seluruhnya — **dibatalkan satu fakta**: tanda tangan SigV4 mencakup path dan header `Host`. Prefiks `/blob/` yang di-strip proxy membuat tanda tangan tidak cocok; yang tidak di-strip menuntut Garage menerima prefiks itu sebagai bagian bucket. Keduanya rapuh terhadap konfigurasi proxy yang bukan milik kita.

Jadi **hostname sendiri** (`blob.factory.example`), proxy meneruskan path dan `Host` apa adanya, dan **CORS di bucket** dengan origin persis dari config — `GET` untuk browser, `PUT` untuk Runner. Satu nama DNS lagi, dinyatakan di langkah operator ticket 28, bukan ditemukan orang saat log pertama gagal dimuat.

**5 menit dinyatakan, tidak diperpendek.** Memperpendek jadi 30 detik tidak membeli apa pun yang nyata — orang yang sudah memegang URL sudah memegang byte-nya jauh lebih cepat dari itu — sementara ia mulai memutus unduhan artefak besar di koneksi lambat, kegagalan yang akan sering terjadi. Kalimat yang masuk spec:

> Mencabut akses seseorang berlaku seketika untuk semua yang **akan** ia minta. URL presigned yang sudah terbit tetap valid sampai ≤5 menit. Pencabutan bukan penarikan kembali.

### Menjawab Question: kalah balapan adalah keadaan, bukan error

Ticket 14 mengunci jawaban pertama menang lewat compare-and-set; ticket 17 menaikkan taruhannya karena layar grilling menampilkan draf yang tumbuh sambil dibicarakan.

Endpoint menjawab **`409` dengan badan yang memuat Question terbaru** beserta penjawab dan jawabannya. Klien tidak menampilkan toast merah — ia **menerapkan state itu**: kotak yang sedang kamu ketik berubah jadi kartu *"Budi sudah menjawab: …"*, dan **teks yang telanjur kamu ketik tidak dibuang**, ia tinggal sebagai draf mati yang bisa disalin. Membuang ketikan orang karena kalah 200 milidetik adalah kerugian yang tidak sebanding dengan penyebabnya.

Konsekuensi yang menyenangkan: karena poll 3 detik sudah jalan di layar itu, **`409` hampir tidak pernah jadi jalur utama** — poll lebih dulu mengubah layar jadi "sudah dijawab" sebelum jari sampai ke tombol. `409` adalah jaring pengaman untuk jendela 3 detik, dan itu berarti kasus ini tidak menuntut satu pun mekanisme realtime tambahan.

**Suntingan draf memakai penguncian yang sama dengan Question.** Ticket 17 mengunci sunting-langsung dan ticket 15 membuat riwayatnya gratis (Artifact immutable per StepRun), tapi dua orang menyunting draf yang sama pada giliran yang sama adalah balapan **menulis Artifact**, yang compare-and-set ticket 14 tidak tutupi. Aturannya: draf hanya bisa disunting oleh orang yang sedang memegang giliran menjawab; siapa pun yang belum menjawab melihatnya **read-only**. Nol mekanisme kedua. Harganya "dua orang tidak bisa menyunting bersama", yang untuk grilling session memang bukan bentuk yang diinginkan.

### Editor pipeline: nama user, tanpa credential user

Sub-pertanyaan 7 ditandai badan ticket sebagai satu-satunya yang tidak punya jawaban tersedia di ticket mana pun. Editor bukan StepRun dan tidak punya giliran, sementara ticket 10 mengunci token di-mint per giliran.

Ditolak: **token OAuth user sendiri**. Ia memberi atribusi GitHub yang benar tapi menuntut kita menyimpan token GitHub per-user berscope `repo` — persis yang ticket 10 buang dengan alasan tertulis (*"PAT terikat akun manusia dan lolos dari offboarding"*) — dan token itu bisa menulis ke **semua** repo yang user itu bisa tulis, jauh lebih luas dari installation token yang dipersempit `repository_ids`.

Ternyata dikotominya tidak perlu dipilih, karena **git memisahkan author dari committer**, dan GitHub menghitung kontribusi dari **author**. Installation token menentukan *boleh push*, bukan *tertulis siapa*:

```
author     = user penekan tombol
             <github-id>+<username>@users.noreply.github.com
committer  = factory[bot]
push       = installation token ad-hoc, repo tuan rumah saja,
             contents:write + pull_requests:write, DELETE setelah selesai
```

Alamat `users.noreply.github.com` dipilih karena selalu terpetakan ke akun untuk keperluan kontribusi dan tidak pernah membocorkan email pribadi — banyak orang menyembunyikan alamat aslinya, jadi memakai email profil akan gagal senyap untuk sebagian tim. `Co-authored-by:` jadi tidak perlu; ia solusi untuk masalah yang author-field selesaikan lebih baik.

Dua syarat dinyatakan supaya ini bukan janji kosong:

- Kontribusi baru terhitung setelah commit **mendarat di default branch**. PR editor yang tidak pernah di-merge tidak muncul di grafik siapa pun, dan itu benar.
- Commit dibuat lewat **Git Data / Contents API**, bukan clone lokal — editor menulis satu file YAML, jadi tidak ada alasan menyiapkan worktree. Klaim bahwa commit lewat API dengan installation token muncul `Verified` sudah **diprobe 2026-08-12 (#42) dan terbukti salah**: GitHub hanya menandatangani commit API yang tidak menyebut `author` maupun `committer`. Karena atribusi ke user adalah inti fitur ini, commit editor unsigned (ADR-0004).

Dua hal jatuh gratis: **`member` boleh** (ticket 11 sudah menolak peran `maintainer` karena memisahkan "menulis Pipeline" dari "menjalankan Pipeline" tidak berarti untuk tim internal), dan validasi PR editor lewat jalur PR check ticket 08 apa adanya.

Ini juga **pemakaian pertama `pull_requests:write` di luar `kind: pull-request`**, dan permukaannya tidak melebar: ticket 16 sudah memberikan izin itu ke control plane, dan Sandbox tetap tidak pernah melewati `contents:write`.

### Penolakan izin: 403 yang menawarkan jalan keluar, bukan 404 yang menguburnya

Refleks industri adalah 404 untuk semuanya supaya keberadaan resource tidak bocor. **Ditolak**, dan bukan demi kenyamanan — model ancamannya tidak ada di sini: semua yang bisa login sudah karyawan satu tim, daftar Project sudah terlihat, dan id UUIDv7 (ticket 25) tidak bisa ditebak. Enumerasi tidak membeli apa pun bagi orang yang sudah di dalam.

Harga 404 justru nyata dan berulang, dan menghantam desain ticket 11 sendiri: `owner` org yang membuka tautan Run dari chat melihat "tidak ditemukan", menyimpulkan sistemnya rusak, dan melapor bug — padahal ticket 11 **sengaja** menyediakan jalan keluar untuk situasi persis itu (owner menambahkan dirinya jadi anggota, dan tindakan itu teraudit). **404 menyembunyikan keberadaan jalan keluar yang dirancang khusus untuknya.**

```
401  belum login / sesi mati
403  login, tapi tidak boleh — badan menyebut project_id dan sebabnya
404  benar-benar tidak ada
```

Dan `403` di UI bukan halaman buntu: kalau Principal-nya owner org, layar menawarkan *"tambahkan dirimu sebagai anggota Project X"* dengan peringatan bahwa tindakan itu tercatat. Itu mengubah "tidak ada superuser diam-diam" dari larangan jadi alur kerja — niat ticket 11 yang 404 akan kubur.

Yang bocor, dinyatakan telanjang: **seseorang yang sudah memegang id resource bisa tahu resource itu ada.** Tidak lebih.

### Daftar dan paginasi: cursor-nya adalah id, dan itu jatuh gratis

Ticket 25 sengaja tidak menyentuh indeks daftar — yang ada di sana hanya partial index untuk klaim, dedup, retensi, dan Question terbuka. Sisi ini memang kosong sampai sekarang.

**Keyset, dan cursor-nya `id` itu sendiri.** Ini jatuh gratis dari keputusan ticket 25 yang diambil untuk alasan yang sama sekali lain: **id adalah UUIDv7**, jadi urutan id *adalah* urutan waktu. Nol cursor gabungan, nol encoding, nol tiebreaker.

```sql
WHERE project_id = $1 AND id < $cursor ORDER BY id DESC LIMIT $n
index: (project_id, id DESC)
```

Offset ditolak dengan alasan yang khusus berlaku di sini: layar ini **poll tiap 3 detik** dan daftarnya tumbuh di kepala, jadi baris bergeser di bawah pembaca dan halaman 2 menampilkan baris yang sama dua kali. Bukan kasus pinggiran — itu perilaku normalnya.

**Tanpa total count.** Tidak ada "1–50 dari 1.284", yang ada tombol *muat lebih banyak*. Angka total menuntut scan kedua atas seluruh sejarah untuk sesuatu yang tidak pernah mengubah keputusan siapa pun.

**Filter himpunan tertutup, bukan bahasa kueri**, dan pembagiannya mengikuti ticket 06 apa adanya — dua pertanyaan berbeda, dua kolom berbeda: *sedang berjalan* → `ended_at IS NULL`; *vonis akhir* → `outcome = …`, yang menurut ticket 25 hanya ada setelah Run berakhir. Ditambah `pipeline` dan `triggered_by`. Satu index komposit saja yang dibayar — `(project_id, ended_at, id DESC)` — karena "tunjukkan yang masih jalan" dan "tunjukkan yang gagal" adalah dua dari tiga alasan orang membuka daftar ini. Sisanya scan biasa: ini ratusan sampai ribuan baris per Project, bukan ratusan juta.

**"Menunggu saya"** (ticket 19, diurutkan umur) dapat partial index sendiri, mungil secara alami karena hanya memuat yang belum dijawab: `questions (created_at) WHERE answered_at IS NULL`.

**Tiga agregasi ticket 20 tidak menumpang poll.** Endpoint terpisah, diambil saat layarnya dibuka. Lencana boleh menumpang karena ia satu angka dari index mungil; agregasi biaya adalah `GROUP BY` atas sejarah, dan menaruhnya di jalur poll berarti membayarnya 20 kali per menit per tab untuk angka yang berubah tiap beberapa menit.

### Empat tombol tulis, dan idempotensi yang tidak menambah kunci baru

Keempatnya sudah dijanjikan prototype dan tinggal diberi bentuk request, aturan izin, dan jejak audit.

| Tombol | Endpoint | Izin | Sumber |
|---|---|---|---|
| Cancel Run | `POST /runs/:id/cancel` | `member` | 13, mekanik di 06 |
| Rewind | `POST /runs/:id/rewind` | `member` | 17, bentuk di 06 |
| Pemicu manual | `POST /pipelines/:id/runs` | `member` | 22 |
| Sakelar `automation_enabled` | `POST /projects/:id/automation` | `admin` | 22 |

**Cancel mengakui seketika sebagai niat, bukan sebagai fakta.** Responsnya mengembalikan Run dengan `cancel_requested_at` terisi, sementara mekanik ticket 06 (heartbeat ≤10s → SIGTERM → 30 detik → SIGKILL) berjalan di belakang. Dua keadaan, bukan satu — tanpa pemisahan itu tombol terlihat menggantung 10 detik di layar yang poll tiap 3 detik.

**Idempotensi: nol kunci baru, sama seperti temuan ticket 26.** Cancel dan sakelar automation idempoten secara alami. Rewind dan pemicu manual tidak — klik ganda melahirkan dua Run. Yang menutupnya sudah ada: ticket 25 mengunci **id bisa dibangkitkan klien**, jadi request membawa id Run barunya sendiri dan primary key menolak duplikat. Properti itu dipilih ticket 25 demi AAD ticket 10 (id harus ada sebelum enkripsi), dan ia dibayar kedua kalinya di sini gratis. Keduanya juga sudah lolos struktural dari partial unique index (Pipeline, SHA) ticket 25, yang berlaku hanya saat `trigger_kind = 'automation' AND parent_run_id IS NULL`.

`automation_enabled` mendapat `admin`, bukan `member`, karena ia setelan Project — kelas yang sama dengan `allowSharedAgentCredential` dan allowlist egress yang sudah ada di daftar audit ticket 11. Harganya dinyatakan: kalau insiden terjadi saat tidak ada `admin` yang online, yang tersedia bagi `member` tetap Cancel per Run.

**Audit: 9 jenis jadi 10.** #9 "Terbitkan PAT" gugur bersama PAT. Ditambahkan dua: **Cancel Run** (tindakan destruktif atas kerja orang lain; "siapa yang membunuh Run saya" adalah pertanyaan nyata) dan **ubah `automation_enabled`**. Rewind dan pemicu manual masuk #8 "Picu Run" apa adanya; owner yang menambahkan dirinya masuk #4 "Ubah peran dan keanggotaan".

Ditolak sebagai jenis audit: **PR yang dibuka editor**. PR itu sendiri sudah catatan permanen ber-atribusi di GitHub, dengan author user yang menekan tombol. Mencatatnya lagi berarti menduplikasi rekaman yang sudah hidup di tempat yang lebih baik, dan ticket 11 menulis daftarnya sengaja pendek supaya tetap dibaca.

### Konsekuensi ke ticket lain

- **11 (closed)** — **PAT `sf_` dihapus**, jenis kejadian audit #9 gugur. Ditambahkan dua jenis (Cancel Run, ubah `automation_enabled`), jadi 10. Sesi cookie dipertegas bentuknya; garis ambient-untuk-otentikasi / eksplisit-untuk-otorisasi ditulis. `member` boleh membuka PR editor — turunan langsung dari penolakan peran `maintainer`, bukan aturan baru.
- **26 (closed)** — nol koreksi. Gaya REST-nya diikuti, dan alasan OpenAPI-nya **diganti**: bukan demi pembaca manusia, melainkan demi klien Kotlin yang dibangkitkan.
- **18 (closed)** — dikonfirmasi tanpa perubahan: browser memakai endpoint long-poll yang sama persis dengan yang dirancang di sana.
- **15 (closed)** — presigned 5 menit dipertahankan dan **dinyatakan** sebagai batas pencabutan, bukan diperpendek. CORS bucket dan hostname `blob.*` jadi bagian kontrak.
- **07 (closed)** — alasannya sengaja **tidak** dipinjam untuk browser; ditulis supaya tidak ada yang mengira WS ditolak dua kali karena satu alasan.
- **17 (closed)** — sunting draf dibatasi ke pemegang giliran menjawab; kalah balapan jadi keadaan, bukan error.
- **19 (closed)** — lencana menumpang respons poll, nol interval sendiri. Sub-pertanyaan 5 lunas tanpa keputusan terpisah.
- **Notes map** — "Hono atau Fastify" berhenti jadi pertanyaan terbuka; ia jadi tidak berkonsekuensi.

### Yang diambil agent sendirian

Sub-pertanyaan **1, 2, 3, 7** digrill penuh dengan user dan dua di antaranya berbalik karena premis yang user bawa (PAT tanpa konsumen; mobile Compose Multiplatform). Sub-pertanyaan **6 dan 10** disetujui user dalam satu kata. Sub-pertanyaan **4, 5, 8, 9 diambil agent sendirian atas permintaan user — belum diadu.**
