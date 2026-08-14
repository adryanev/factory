# Kontrak API control-plane ↔ Runner

Type: grilling
Status: resolved
Blocked by: 25

## Question

Destination menyebut kontrak ini eksplisit sebagai bagian spec. Potongannya sudah tersebar di enam ticket dan tidak pernah dijahit: `/claim` long-poll ≤30s dan `/heartbeat` 10s sebagai satu-satunya kanal perintah (ticket 07), long-poll log dari offset yang **memakai ulang bentuk `/claim`** (ticket 18), presigned dua arah supaya control plane tak pernah memegang byte (ticket 15), POST Question sebagai satu-satunya titik commit sebuah giliran (ticket 14), versi protokol integer terpisah dari rilis (ticket 07), dan penukaran join token (ticket 07).

Ticket ini menjahitnya jadi satu permukaan dan menjawab yang belum pernah ditanya.

1. **Enumerasi lengkap, dan apa yang ternyata belum punya endpoint.** Menghitung mundur dari satu giliran utuh: klaim → fetch branch → jalankan agent → push branch → unggah session → catat Artifact → laporkan Output → laporkan akhir StepRun. Ticket 14 mengunci urutan commit untuk giliran yang berakhir dengan Question; giliran yang berakhir `done` belum punya urutan yang setara, dan invarian yang sepadan dengan *Question ada ⇒ ref dan session pasti ada* harus ditulis atau dinyatakan tidak perlu. Ticket 23 menempatkan validasi Output di dua tempat — Runner untuk umpan balik, control plane sebagai gerbang otoritatif — jadi Output menyeberang kawat dan penolakannya adalah respons yang Runner harus tahu cara membaca.

2. **Otentikasi di kawat.** Ticket 07 mengunci identitas Runner ada di file `runner.secret`, bukan hostname atau IP, dan ticket 10 menaikkan taruhannya: di `exec:host` agent berjalan sebagai user OS terpisah justru supaya ia tidak bisa `cat runner.secret` dan naik jadi Runner. Yang belum diputuskan: apakah secret itu dikirim apa adanya sebagai bearer tiap request, atau dipakai menandatangani. Bearer polos di atas TLS cukup dan sederhana; tapi kalau ia polos, ia muncul di log proxy mana pun yang dipasang operator, dan itu harus dinyatakan atau ditutup.

3. **Versi protokol: di mana ia dikirim dan apa yang terjadi saat tidak cocok.** Ticket 07 mengunci integer terpisah dari rilis dan menyatakan Runner basi tetap terlihat tapi tidak pernah dapat kerja. Yang belum: apakah versi ikut tiap request atau cuma saat join, apakah kontrolnya di `/claim` (kembalikan kosong selamanya) atau di `/heartbeat` (kembalikan `desired_state` baru yang berarti "kamu terlalu tua"), dan yang mana yang membuat operator **melihat** sebabnya alih-alih melihat Runner sehat yang tidak pernah bekerja.

4. **Bentuk wire dan dari mana tipenya datang.** Notes mengunci skema Zod di `shared` dipakai ketiganya, jadi satu definisi melahirkan validasi runtime dan tipe. Yang belum: apakah ada dokumen kontrak yang bisa dibaca tanpa membaca TypeScript (OpenAPI dibangkitkan dari Zod), dan apakah Runner mengimpor `shared` sebagai paket workspace — kalau ya, Runner dan control plane selalu dirilis dari commit yang sama, dan sub-pertanyaan 3 jadi setengah teoretis; kalau tidak, tipenya harus disalin dan drift jadi mungkin.

5. **Semantik error, dan siapa yang boleh mencoba lagi.** Ticket 24 mengunci "patuhi `Retry-After`" untuk panggilan kita ke GitHub. Arah sebaliknya belum: control plane yang kelebihan beban atau sedang di-restart menjawab apa, dan apakah Runner membedakan gagal-boleh-diulang dari gagal-fatal lewat status HTTP atau lewat field. Yang membuat ini penting bukan kerapian: `/claim` yang keliru dianggap fatal membuat Runner berhenti poll dan hilang dari kolam tanpa mati.

6. **Idempotensi.** Ticket 07 mengambil idempotensi dua lapis dari owainlewis/factory tanpa memetakannya ke request kita. Yang harus dipetakan di sini: laporan akhir StepRun (dikirim dua kali karena respons hilang), pencatatan metadata Artifact (ticket 15 mengunci upload dulu → catat metadata, jadi catatan kedua atas blob yang sama harus tidak apa-apa), dan POST Question (ticket 14 sudah menjawabnya dengan "mati sebelum POST = attempt baru dari turn yang sama" — yang belum: POST yang sampai tapi responsnya hilang).

7. **Mekanik long-poll di bawah tekanan.** Control plane restart dan seluruh kolam Runner memanggil `/claim` bersamaan; ticket 07 mewarisi "sweep sebelum listener dibuka" dari owainlewis tapi tidak menyebut jitter atau backoff. Diputuskan di sini, bersama batas berapa koneksi menggantung yang satu instance tahan — angka itu yang menentukan apakah "control plane tetap stateless" benar-benar bebas biaya.

8. **Perintah lewat heartbeat, dan jendela yang tersisa.** Ticket 07 mengunci `/heartbeat` sebagai satu-satunya kanal perintah (cancel, `desired_state`, `latest_release`); ticket 06 mengunci cancel ≤10s → SIGTERM process group → 30 detik → SIGKILL. Bentuk muatannya diputuskan di sini. Satu kasus pinggiran yang belum punya jawaban: StepRun yang sedang `awaiting-human` tidak punya Runner untuk diberi tahu apa pun, dan ticket 22 menambahkan cancel otomatis saat branch dihapus — jalur itu murni penulisan baris DB (ticket 14), jadi kontrak ini harus menyatakan ia memang tidak menyentuh Runner sama sekali.

9. **Batas ukuran dan timeout.** Chunk log berukuran kilobyte (ticket 18), manifest Join berbentuk JSON (ticket 06), Output tervalidasi (ticket 23), muatan probe kapabilitas (ticket 07). Batas per request dan perilaku saat terlampaui — dan khusus log, ring buffer 64MiB dan batas 256MiB ticket 18 adalah mekanisme di Runner, bukan di kawat; kontrak ini harus menyatakan apa yang terjadi di kawat saat keduanya aktif.

Rekomendasi awal untuk diuji: bearer polos di atas TLS dengan pernyataan eksplisit soal log proxy, versi protokol ikut tiap request tapi ditegakkan di `/heartbeat` supaya sebabnya terlihat operator, `shared` sebagai paket workspace dengan OpenAPI dibangkitkan untuk dibaca manusia, dan idempotency key hanya pada tiga request yang menulis.

## Answer

Sembilan permukaan yang tersebar di enam ticket ternyata menjahit jadi **sembilan endpoint POST dan nol endpoint GET**, dan sub-pertanyaan idempotensi tertutup bukan oleh keputusan baru melainkan oleh constraint yang sudah ada di ticket 25 — primary key, partial unique index, dan lease token yang sudah dipegang.

### Satu titik commit per giliran, apa pun akhirnya

Ticket 14 mengunci `push branch → unggah session → POST Question` untuk giliran yang bertanya. Pasangannya untuk giliran yang selesai:

```
push branch  →  unggah semua blob ke Garage  →  POST /step-runs/:id/result
```

Invarian yang lahir, sejajar dengan milik ticket 14:

> **StepRun `succeeded` ada ⇒ ref ada, dan Output-nya sudah lolos gerbang otoritatif.**

Metadata Artifact **menumpang request akhir itu**, bukan dicatat mengalir saat tiap artefak selesai naik. Alasannya bukan kerapian: ticket 23 menaruh gerbang otoritatif Output di control plane, jadi Output yang ditolak harus membuat seluruh giliran itu seolah tidak pernah terjadi — dan itu hanya benar kalau baris artefaknya belum terlanjur tercatat request sebelumnya. "Upload dulu → catat metadata" ticket 15 tetap utuh; yang berpindah cuma *kapan* metadata dicatat, bukan urutannya, dan invarian *baris Artifact ada ⇒ blob pasti ada* tidak tersentuh.

Asimetri ticket 15 terbayar tanpa aturan baru: artefak yang gagal naik permanen **tidak masuk daftar**, dan StepRun tetap sukses.

Harga yang dibayar sadar: artefak tidak muncul di UI sampai StepRun berakhir — StepRun 45 menit menampilkan log saja sampai detik terakhir. Ditolak: **POST metadata per artefak saat jadi** — membeli artefak yang muncul mengalir, dengan menciptakan keadaan "artefak sudah tercatat untuk StepRun yang lalu gagal `output-invalid`" yang harus punya tampilan di UI, aturan pembersihan di GC, dan penjelasan di dua tempat.

Giliran yang **gagal** memakai endpoint yang sama dengan `outcome: failed` plus `reason`, dan `ref` opsional — kalau branch sempat terdorong, ia dicatat. Ticket 18 sudah menetapkan log attempt yang mati tidak ditimpa justru supaya bisa dibaca; ref attempt yang mati mengikuti alasan yang sama.

### Enumerasi: sembilan endpoint, semuanya POST

```
POST /join                          token sekali pakai → { runner_id, secret }
POST /claim                         long-poll 20–30s   → StepRun + ref + secrets + lease_token
POST /heartbeat                     tiap 10s           → satu-satunya kanal perintah
POST /runners/me/capabilities       laporan penuh saat caps_hash berubah
POST /runners/me/drain              CLI lokal menulis desired_state
POST /step-runs/:id/uploads         mint presigned PUT (artifact + session, satu batch per giliran)
POST /step-runs/:id/log-chunks      catat metadata chunk (batch)
POST /step-runs/:id/question        titik commit giliran bertanya  (ticket 14)
POST /step-runs/:id/result          titik commit giliran selesai/gagal
```

**Nol GET, dan itu bukan kebetulan.** Semua yang Runner butuh untuk bekerja ikut di muatan `/claim`: ref, secret Project, token repo per-StepRun (ticket 10), snapshot definisi dan file prompt (`runs.definition_files` inline, ticket 25), dan presigned GET session untuk giliran lanjutan (ticket 14). Runner tidak pernah menanyakan apa pun tentang dunia; ia diberi tahu sekali, lalu melapor. `GET /step-runs/:id/log` ticket 18 **bukan** bagian kontrak ini — Runner tidak pernah membaca log, itu permukaan ticket 27.

Ditolak: **prefiks `/v1`**. Ticket 07 sudah mengunci integer protokol sebagai mekanisme versi. Prefiks path adalah nomor versi kedua yang harus dinaikkan seirama dengan yang pertama, dan dua nomor untuk satu pertanyaan adalah persis bentuk yang ticket 02 peringatkan.

`POST /runners/me/drain` adalah bagaimana "drain punya satu mekanisme, bukan dua" (ticket 07) benar-benar terwujud: CLI lokal dan tombol UI **sama-sama menulis kolom `desired_state`**, dan proses Runner tidak pernah mendengar keduanya — ia hanya patuh pada balasan heartbeat. Tombol UI-nya sendiri milik ticket 27.

### Otentikasi: bearer polos, dan kekhawatiran log proxy salah alamat

`Authorization: Bearer sfr_<secret>` di atas TLS. Server menyimpan **SHA-256**-nya, pola yang sama dengan PAT `sf_` ticket 11; prefiks `sfr_` supaya string yang bocor bisa dikenali sumbernya.

Kekhawatiran yang ditulis di badan ticket ternyata tidak berlaku: secret ada di **header**, dan reverse proxy tidak mencatat header request di access log bawaannya — yang dicatat adalah method, path, status, dan sering **query string**. Maka aturannya bisa dinyatakan tajam dan mudah dipatuhi:

> **Tidak ada credential yang pernah muncul di path maupun query string.**

Yang justru muncul di query string adalah tanda tangan presigned URL — dan itu aman di sini karena presigned URL menuju **Garage, bukan control plane**, jadi ia tidak pernah melewati proxy kita, dan umurnya 5 menit (ticket 15).

Ditolak: **menandatangani request (HMAC)**. Ia menuntut kanonikalisasi, jendela clock skew, dan penyimpanan nonce untuk anti-replay sebelum memberi manfaat apa pun. Manfaat yang dibelinya hanyalah perlindungan terhadap penyerang yang bisa membaca lalu lintas setelah TLS diterminasi — dan penyerang yang menguasai titik itu bisa memutar ulang request bertanda tangan apa adanya, kecuali kita juga membangun penyimpanan nonce. Biaya penuh, manfaat separuh.

Revoke ticket 07 (`secret=NULL`) berarti seluruh request Runner itu **401**, dan 401 adalah satu-satunya respons yang membuat Runner berhenti (lihat semantik error).

### Versi protokol: ikut tiap request, ditegakkan di dua tempat dengan dua cara

```
X-Factory-Protocol: 4        wajib di setiap request, termasuk /join
X-Factory-Release: 0.4.2     informasi, ditampilkan di UI
```

Batasnya dua sisi — control plane mengumumkan `[min, max]`, dan Runner yang **lebih baru** dari control plane ditolak sama tegasnya dengan yang lebih tua. Runner tidak pernah menurunkan diri ke protokol lama; dua format di satu biner adalah cabang yang harus diuji selamanya.

```
/heartbeat  → SELALU diterima, walau di luar rentang
              balasan memuat { protocol: { min, max }, latest_release }
              UI: laptop-A ⚠ unsupported (protocol 3 < 4)

/claim      → 426 Upgrade Required, badan menyebut min dan max
              Runner: berhenti long-poll, poll lambat 60s, heartbeat tetap 10s
```

**426, bukan 204.** Ini titik yang sub-pertanyaan 3 tuntut dijawab: `/claim` yang menjawab kosong membuat Runner terlihat sehat dan selamanya menganggur, dan operator tidak punya satu pun tempat untuk melihat sebabnya. 426 adalah kode yang artinya persis itu, terbaca di log Runner, dan lencananya tetap datang dari heartbeat yang sengaja tidak pernah menolak.

### Bentuk wire: JSON, Zod di `shared`, OpenAPI dibangkitkan dan dijaga CI

`shared` adalah **paket workspace**, dan Runner mengimpornya. Satu definisi Zod melahirkan validasi runtime di ketiga komponen dan tipe di dua di antaranya.

Ini **tidak** membuat versi protokol jadi teoretis, dan itu perlu dinyatakan karena badan ticket menduga sebaliknya: yang selalu sama commit adalah **build**-nya, bukan yang **terpasang**. Ticket 07 mengunci pembaruan Runner manual — operator menjalankan ulang installer — jadi laptop yang tidak disentuh dua bulan tetap bicara protokol lama ke control plane yang sudah naik. Skew-nya nyata di runtime justru karena distribusinya manual.

OpenAPI **dibangkitkan dari Zod, di-commit ke repo, dan diperiksa CI** — dokumen yang keluar dari generator harus identik dengan yang tersimpan, kalau tidak CI merah. Dengan begitu ada kontrak yang bisa dibaca tanpa membaca TypeScript, dan ia tidak bisa basi diam-diam. Ditolak: **OpenAPI ditulis tangan** — sumber kebenaran kedua yang drift-nya baru ketahuan saat ada yang mengeluh.

Muatan JSON di semua endpoint. Tidak ada format biner: satu-satunya byte besar di sistem ini (log, session, artefak) tidak pernah lewat kawat ini.

### Semantik error: kelas ditentukan status, dan hanya satu yang mematikan

| Status | Arti | Yang Runner lakukan |
|---|---|---|
| `401` | secret salah atau dicabut | **berhenti**, keluar dengan pesan |
| `426` | protokol di luar rentang | poll lambat 60s, heartbeat jalan terus |
| `409` | lease bukan milikmu lagi, StepRun sudah `cancelled`/berakhir | lepaskan StepRun itu, lanjut `/claim` |
| `400` `422` | muatan ditolak, termasuk Output ditolak gerbang otoritatif | fatal untuk giliran itu, bukan untuk Runner |
| `413` | melewati batas ukuran | fatal untuk request itu |
| `429` `503` | kelebihan beban atau sedang restart | backoff, **patuhi `Retry-After`** |
| `5xx` lain, timeout, koneksi putus | tidak diketahui | backoff, ulangi |

Badan respons memuat `{ code, message }` dengan `code` stabil untuk log dan UI, tapi **Runner tidak pernah bercabang atas `code`** — kelasnya sudah lengkap dari status. Satu sumber kebenaran untuk keputusan, satu lagi untuk manusia.

Aturan yang ditulis sebagai satu kalimat karena ia yang mahal kalau salah:

> **Hanya 401 yang membuat Runner berhenti.** Apa pun yang lain, ia tetap meng-heartbeat dan tetap kembali ke `/claim`.

Ini menutup persis bahaya yang badan ticket sebut: `/claim` yang keliru dianggap fatal membuat mesin hilang dari kolam tanpa mati.

`Retry-After` dipatuhi di sini karena ticket 24 sudah mematuhinya ke arah GitHub — satu konvensi, dua arah, nol mekanisme baru.

### Idempotensi: tidak ada satu pun kunci baru yang perlu dibangun

Empat request menulis. Keempatnya sudah punya penjaganya masing-masing di ticket 25.

| Request | Yang membuatnya idempoten | Ulangan menghasilkan |
|---|---|---|
| `POST /log-chunks` | PK `(step_run_id, attempt, seq)`, `ON CONFLICT DO NOTHING` | `200`, nol baris tersentuh |
| `POST /question` | `question_id` dibangkitkan klien (TypeID, ticket 25) | `200` + Question yang sudah ada |
| `POST /result` | **`lease_token` itu sendiri** | `200` + hasil yang sudah tercatat |
| `POST /uploads` | grant **diganti**, bukan ditambah | presigned URL untuk key yang sama |

`lease_token` sebagai kunci idempotensi `/result` adalah yang menghapus kebutuhan kolom baru: ia sudah unik per `(StepRun, attempt)` dan sudah dibawa Runner. Aturannya satu baris — StepRun yang sudah berakhir menjawab `200` kalau `lease_token` yang melapor **sama** dengan yang menuliskannya, dan `409` kalau berbeda. Yang pertama adalah respons yang hilang; yang kedua adalah Runner ter-fence (ticket 07) yang tulisannya memang harus ditolak.

Ini menjawab lubang yang ticket 14 tinggalkan (*POST yang sampai tapi responsnya hilang*) untuk ketiga jalur sekaligus.

**Kuota tanpa penghitung.** Ticket 15 menuntut kuota ditolak saat presigned diminta, bukan setelah 200MB naik. Karena artefak sebuah giliran lahir di akhir giliran, `/uploads` diminta **sekali per (StepRun, attempt)** sebagai satu batch berisi seluruh artefak plus session. Permintaan ulang **mengganti** grant sebelumnya alih-alih menambahnya, jadi 1GiB per artefak dan 5GiB per StepRun diperiksa atas satu daftar utuh dan tidak pernah bisa hanyut. Nol tabel baru — daftar tabel ticket 25 tetap apa adanya.

Presign untuk log adalah jalur terpisah dan **tidak ikut kuota artefak** (ia punya batas 256MiB sendiri, ticket 18): batch 64 URL sekali minta, key-nya turunan `seq`, jadi minta ulang rentang yang sama menghasilkan URL untuk key yang sama — idempoten karena bentuknya, persis alasan yang sama dengan chunk di ticket 18.

### Long-poll: jitter di server, dan angka yang membuat "stateless" bisa diperiksa

Herd sesudah restart tidak diselesaikan dengan meminta Runner sopan. **Durasi tahan long-poll diacak server di rentang 20–30 detik**, jadi kolam yang datang bersamaan pecah sendiri dalam satu siklus, dan Runner berversi lama tidak bisa memilih untuk tidak ikut. Backoff di sisi Runner tetap ada, tapi hanya untuk kegagalan koneksi dan `5xx`: eksponensial dengan full jitter, 100ms → 30s.

Implementasi tahan-nya adalah **poll kueri klaim tiap 1 detik per koneksi yang menggantung**, bukan `LISTEN/NOTIFY`. Angkanya yang membuat ini jujur: 100 Runner = 100 kueri indexed per detik, beban yang tidak terasa di Postgres mana pun. `LISTEN/NOTIFY` menurunkannya jadi O(instance) alih-alih O(Runner) dan **aditif murni** — satu koneksi LISTEN per instance, tanpa mengubah satu pun bentuk request. Ia masuk kabut, bukan ke sini; aturan map menuntut ukuran sebelum optimisasi.

Batas koneksi menggantung: **2000 per instance**, di atasnya `/claim` menjawab `503` + `Retry-After`. Tiap koneksi menggantung adalah satu socket plus closure, bukan thread, jadi angka ini jauh di atas kolam puluhan mesin yang kita punya — ia ada sebagai pagar terhadap bug, bukan sebagai kapasitas yang diperebutkan.

Satu kendala deployment yang lahir dari sini dan harus masuk dokumen packaging (ticket 28): **reverse proxy di depan control plane wajib punya read timeout ≥60 detik.** Proxy dengan bawaan 30 detik akan memutus long-poll tepat di batasnya dan menghasilkan Runner yang sehat tapi cerewet.

### Heartbeat: muatan perintah, dan fencing yang akhirnya punya kawat

```
POST /heartbeat
  { leases: [{ step_run_id, lease_token }], caps_hash, free_slots }

→ { desired_state : "active" | "draining" | "revoked",
    cancel        : ["str_..."],     // SIGTERM process group, 30s, SIGKILL
    unknown_leases: ["str_..."],     // bukan milikmu lagi — hentikan SEKARANG
    caps_stale    : true,            // kirim laporan penuh
    latest_release: "0.6.0",
    protocol      : { min: 4, max: 5 } }
```

`unknown_leases` adalah satu-satunya bidang yang tidak diwarisi dari ticket 07, dan ia yang memberi fencing sebuah kawat: Runner yang lease-nya sudah disapu (laptop ketiduran, jaringan putus 40 detik) selama ini baru tahu saat tulisannya ditolak di akhir giliran — artinya ia membakar compute untuk pekerjaan yang sudah dijadwalkan ulang di mesin lain. Dengan bidang ini ia tahu dalam ≤10 detik. Ditolak: **memasukkannya ke `cancel`** — dua sebab berbeda di satu daftar, dan operator kehilangan kemampuan membedakan "dibatalkan orang" dari "kamu kehilangan lease".

**Cancel otoritatif di control plane, bukan di Runner.** Saat tombol ditekan, baris StepRun langsung `cancelled` — UI berubah seketika, sama seperti cancel untuk `awaiting-human` di ticket 14. Balasan heartbeat berikutnya hanya meminta Runner berhenti membakar CPU. Laporan `/result` yang telanjur dikirim untuk StepRun itu dijawab `409` dan dibuang. Latensi 10 detik ticket 07 dengan begitu adalah latensi **berhentinya proses**, bukan latensi berubahnya status — pembedaan yang selama ini tersirat dan sekarang tertulis.

Dan yang badan ticket minta dinyatakan terang:

> Kontrak ini **tidak menyentuh Runner sama sekali** untuk StepRun yang `awaiting-human`. Tidak ada lease, tidak ada Sandbox, tidak ada mesin yang memegang apa pun. Cancel manual (ticket 14) dan cancel otomatis saat branch dihapus (ticket 22) keduanya murni penulisan baris DB. Tidak ada endpoint di daftar sembilan di atas yang terlibat.

### Batas ukuran dan timeout

```
badan JSON              1 MiB   semua endpoint            → 413
body Question           64 KiB  dipotong Runner + marker  (agent bisa cerewet)
batch /log-chunks       256 entri
batch /uploads          64 URL
tahan /claim            20–30s server · timeout klien 35s
endpoint lain           10s server · timeout klien 30s
```

Untuk log, badan ticket menuntut kalimat yang membedakan mekanisme Runner dari yang terlihat di kawat, dan kalimatnya pendek: **di kawat tidak terlihat apa-apa.** Ring buffer 64MiB penuh hanya membuat POST metadata datang terlambat dan satu chunk berisi marker `[log dropped: N bytes]`; batas 256MiB tercapai hanya membuat POST berhenti setelah satu chunk `[log capped]`. Keduanya chunk biasa dengan `seq` biasa, dan **control plane tidak menghitung byte log sama sekali** — ia hanya mencatat `size` yang dideklarasikan.

Konsekuensinya dinyatakan di muka: Runner yang bug atau jahat bisa melewati 256MiB dan control plane tidak akan tahu. Diterima, dengan alasan yang sama bentuknya dengan "redaksi bukan kontrol keamanan" (ticket 15/18): Runner sudah dipercaya memegang secret Project dan token repo, jadi ia ada **di dalam** batas kepercayaan. Batas 256MiB adalah aturan sumber daya untuk Runner yang kooperatif, bukan kontrol keamanan.

### Akibat ke ticket lain

- **27 (open)** — mewarisi tiga konvensi yang tidak perlu diputuskan ulang: `Retry-After` di `429`/`503`, `{ code, message }` di badan error, dan aturan "tidak ada credential di path maupun query". Yang **tidak** diwarisi: gaya permukaan. REST polos dikunci di sini hanya untuk Runner, karena Runner butuh kontrak yang bisa dibaca tanpa TypeScript; browser tidak punya kendala itu.
- **28 (open)** — dua kendala packaging lahir di sini: reverse proxy dengan read timeout ≥60 detik, dan CORS bucket Garage (yang bentuknya diputuskan ticket 27, karena browser yang menuntutnya).
- **25 (closed)** — daftar tabelnya tetap utuh; sifat "id bisa dibangkitkan klien" dipakai persis seperti yang ia ramalkan.
- **07 (closed)** — dua endpoint-nya jadi sembilan, tapi tidak satu pun keputusannya dibatalkan. `unknown_leases` menambah satu bidang di balasan heartbeat.
- **15 (closed)** — pencatatan metadata Artifact berpindah ke request akhir; urutan upload-dulu dan invariannya tidak berubah.

### Yang belum diuji

**Seluruh keputusan di ticket ini diambil agent sendirian.** User menjawab "ikut rekomendasi" setelah pertanyaan pertama, jadi tidak satu pun sempat dibantah — termasuk tiga yang membalik atau memperluas dugaan awal badan ticket: kekhawatiran log proxy yang ternyata salah alamat, `426` menggantikan `/claim` kosong, dan `lease_token` yang menghapus kebutuhan kunci idempotensi baru. Ketiganya konsekuensi dari keputusan yang sudah dikunci ticket lain, tapi ketiganya juga belum pernah melewati orang kedua. Sesi berikutnya yang menyentuh salah satunya sebaiknya membacanya sebagai rekomendasi kuat, bukan keputusan yang sudah diadu.
