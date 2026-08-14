# Notasi kontrak Output di definisi Pipeline

Type: grilling
Status: resolved
Blocked by: —

## Question

Dengan notasi apa sebuah Step menyatakan bentuk Output-nya di file definisi, dan apa yang terjadi ketika yang dihasilkan Agent tidak cocok dengan bentuk itu?

Ticket 05 mengunci bahwa Output adalah **satu Ref + data terstruktur yang tervalidasi skema**, dan bahwa hanya Output yang mengalir di sepanjang Graph. Ticket 08 mengunci bahwa definisi adalah data murni tanpa ekspresi. Yang tidak pernah diputuskan: notasi skemanya sendiri. Prototype ticket 09 memakai bahasa tipe mini yang dikarang di tempat dan tidak pernah dibela:

```yaml
outputs:
  variants:
    type: array
    items: { key: string, brief: string }
```

Ini sekarang jadi tajam karena ticket 09 juga mengunci `branchesFrom: { step, output }` — daftar cabang dibaca dari sebuah Output, jadi control plane harus tahu bahwa Output itu memang daftar, dan bahwa tiap elemennya punya `key`, **sebelum** fan-out dijalankan.

1. **Notasi** — bahasa tipe mini sendiri (di atas), JSON Schema apa adanya, atau sesuatu yang lebih sempit lagi. Bahasa sendiri berarti kita memelihara satu bahasa; JSON Schema berarti seluruh permukaannya ikut masuk (`oneOf`, `$ref`, `patternProperties`) padahal cuma sebagian kecil yang dipakai.
2. **Kedalaman** — apakah bentuk bersarang diizinkan sama sekali, atau Output dibatasi datar (peta string → skalar/daftar) supaya UI punya sesuatu yang pasti bisa dirender.
3. **Siapa yang memvalidasi, dan kapan** — Runner sebelum melapor, atau control plane saat menerima. Ticket 15 memutuskan upload Artifact yang gagal tidak menggagalkan StepRun; Output berlawanan — ia punya kontrak, jadi ketidakcocokan harus punya akibat.
4. **Akibat ketidakcocokan** — StepRun `failed`, atau attempt baru dengan pesan validasi dikirim balik ke agent sebagai prompt. Yang kedua menarik karena agent bisa memperbaiki dirinya, tapi ia menghidupkan giliran yang bukan giliran percakapan (ticket 14 menomori `turn` untuk manusia).
5. **Bagaimana Agent menuliskannya** — file dengan nama yang disepakati di working dir, atau baris terakhir stdout, atau tool call. Ticket 14 menolak control plane mem-parse JSONL internal agent; batasan yang sama berlaku di sini.
6. **`branchesFrom` yang menunjuk Output yang tidak berbentuk daftar** — ditangkap saat validasi definisi (butuh skema Output Step hulu terbaca saat itu juga), atau saat runtime ketika fan-out gagal. Yang pertama lebih baik dan menuntut `outputs:` wajib bagi Step yang di-fan-out darinya.

Zoom ke jawaban ticket 05 untuk pemisahan Output/Artifact, ticket 09 untuk bentuk file yang sudah dipilih, dan ticket 15 untuk pola "kontrak ditulis di skema Output, bukan di daftar artefak".

## Answer

Ticket ini dibuka dengan asumsi bahwa notasi Output adalah halaman kosong. Ia tidak — pembacaan source `@ai-hero/sandcastle` `0.12.0` menemukan **jalur tulisnya sudah ada dan sudah dipilihkan**, dan tiga dari enam sub-pertanyaan ternyata dijawab di luar kita.

### Yang sudah ditentukan sandcastle, bukan oleh kita

**Agent menulis Output sebagai tag XML di stdout.** Bukan file bernama, bukan baris terakhir, bukan tool call — ketiga tebakan sub-pertanyaan 5 meleset. `extractStructuredOutput` (`src/extractStructuredOutput.ts`) mencari kemunculan **terakhir** `<tag>…</tag>` di stdout, membuka fence markdown opsional, `JSON.parse`, lalu memvalidasi. Larangan ticket 14 tidak dilanggar: yang ditolak di sana adalah mem-parse **JSONL internal** tiap agent, dan stdout bukan itu.

**Skemanya Standard Schema** (`Output.object({ tag, schema })`, `src/Output.ts:81`), jadi Zod masuk langsung. Notasi YAML kita murni permukaan — apa pun bentuknya, ia dikompilasi jadi satu validator Zod.

**Satu tag per `run()`.** Ini yang melahirkan konsekuensi terberat ticket ini, di bawah.

### Notasi: bahasa tipe mini sendiri, dua tingkat, batas keras

```yaml
outputs:
  spec:
    type: string
    description: Path file OpenAPI relatif terhadap akar repo.
  variants:
    type: array
    items: { key: string, brief: string }
    description: Satu elemen per varian implementasi.
```

Aturannya tertutup: level atas selalu mapping nama → deskriptor. Deskriptor adalah `{ type: <skalar> }` atau `{ type: array, items: <skalar> | <objek datar> }`. Skalar ∈ `string | number | boolean`. Objek datar adalah mapping field → skalar, **tanpa sarang**. Semua field wajib; opsionalitas tidak ada di v1 dan menambahkannya aditif. `description:` opsional, tidak ikut validasi — ia punya tepat satu pembaca, dan pembaca itu ada di bagian berikutnya.

**JSON Schema apa adanya ditolak**, dan bukan karena selera. Kita tidak bisa menerimanya utuh: `oneOf` membuat UI kehilangan bentuk pasti untuk dirender, `$ref` mengubah pemeriksaan statis `branchesFrom` jadi penjelajahan graf rujukan. Jadi kita akan **tetap** harus menulis validator yang menolak sebagian besar permukaannya — hasil terburuk dari dua dunia, karena orang melihat notasi familiar lalu ditolak saat memakai fitur familiarnya. Menulis subset yang jujur lebih murah daripada menjaga pagar di sekeliling standar besar.

**Datar total ditolak juga** — ia membunuh fan-out dinamis, karena `branchesFrom` justru menuntut daftar objek ber-`key`. Datar total memaksa orang menyelundupkan JSON sebagai string, dan saat itu terjadi kita kehilangan validasi **sekaligus** tetap punya struktur.

Dua tingkat dibela oleh kasus nyata yang sudah ada, bukan oleh tebakan: `variants: array of { key, brief }` (prototype 09), `spec: string` (prototype 09 lintas repo), `{ title, body }` (ticket 16). Tidak satu pun menuntut tingkat ketiga. Yang dibeli batas itu: **UI punya bentuk yang pasti bisa dirender tanpa komponen rekursif** — Output selalu tabel, `array of objects` selalu tabel bersarang satu tingkat.

Validasi `key` sebagai nama Branch yang aman **tidak** diduplikasi ke sini; ia milik ticket 06, dievaluasi saat fan-out.

### Konsekuensi terberat: skema yang dikompilasi adalah union terdiskriminasi

Sandcastle menerima tepat satu `output:` per `run()`. Satu giliran Step interaktif berakhir dua cara — bertanya, atau selesai — dan dua tag mustahil. Kalau `outputs:` dikompilasi jadi `z.object(outputs)` polos, giliran pertama Step interaktif berakhir dengan pertanyaan, tag tidak ditemukan, `run()` melempar `StructuredOutputError`, dan StepRun gagal `output-invalid` **padahal agent bekerja benar**.

Maka satu tag konstanta, dua lengan:

```
<factory-output> {"kind":"question", ...}                  → Runner POST Question
<factory-output> {"kind":"done","outputs":{ ... }}         → Output mengalir ke hilir
```

Step tanpa `ask:` hanya punya lengan `done`, jadi bentuknya persis seperti dugaan semula. Step dengan `ask:` **selalu** dapat definisi `output:` walaupun `outputs:`-nya kosong — tanpa tag, "bertanya" dan "selesai" tidak bisa dibedakan.

Ini **mengisi lubang ticket 14, tidak membantahnya.** Ticket 14 mengunci "agent mengakhiri run-nya setiap kali bertanya" dan menolak parsing JSONL, tapi tidak pernah menyebut lewat apa isi Question sampai ke Runner. Sekarang disebut, dan ia jalur yang sama dengan Output. Dua bonus jatuh gratis: perbaikan-diri agent juga membetulkan Question yang salah bentuk, dan "tag tidak ditemukan" berubah jadi error yang berarti — *agent berhenti tanpa menyatakan apa pun*.

### Siapa yang memvalidasi: dua tempat, dua alasan berbeda

- **Runner lebih dulu**, gratis karena sandcastle sudah melakukannya di dalam `run()`. Tujuannya **bukan** keamanan tapi **umpan balik**: hanya di sini session agent masih hidup, jadi hanya di sini perbaikan-diri mungkin. Control plane tidak punya session dan tidak akan pernah punya.
- **Control plane saat menerima laporan**, dan ini yang **otoritatif**. Bukan karena curiga pada Runner, tapi karena Output satu-satunya hal yang menggerakkan penjadwalan: `branchesFrom` melahirkan cabang dari isinya, `kind: pull-request` membaca `{ title, body }` dari isinya. Nilai yang menggerakkan transaksi penjadwalan tidak boleh masuk tanpa diperiksa di gerbangnya sendiri. Biayanya satu `safeParse`.

Lolos DRY karena skemanya **satu**, dikompilasi dari `outputs:` di definisi yang sama — dan control plane sudah memegang salinan penuh definisi itu (ticket 05, ticket 08). Dua pemanggilan, satu definisi.

Ini juga memberi alasan yang bisa ditulis untuk asimetri dengan ticket 15, yang memutuskan upload Artifact gagal tidak menggagalkan StepRun: **yang tidak dikonsumsi siapa pun boleh hilang; yang menggerakkan Graph tidak boleh masuk tanpa diperiksa.**

### Akibat ketidakcocokan: tiga lapis, lapis ketiga tanpa kasus khusus

Kekhawatiran ticket ini — bahwa "agent memperbaiki dirinya" menghidupkan giliran yang bukan giliran percakapan — **gugur oleh fakta**. Perbaikan-diri terjadi di dalam satu `run()` sebagai rekursi internal sandcastle (`src/run.ts:862-874`). Control plane tidak pernah melihatnya. Ia bukan `turn` dan bukan `attempt`; penomoran ticket 14 tidak tersentuh.

**Lapis 1 — `maxRetries`, dan ia tidak ditulis di YAML.** Runner menurunkannya dari kapabilitas agent: bisa resume (claudeCode, codex, pi) → `2`; tidak bisa (cursor, opencode, copilot) → `0`. Alasannya ranjau di `src/run.ts:572` — `run()` gagal **di pintu masuk** kalau `maxRetries > 0` sementara provider tidak bisa resume. Sebagai bidang YAML itu jebakan siap pakai: orang menulis `maxRetries: 2`, lalu mengganti `agent: claude` jadi `agent: cursor`, dan Step mati sebelum sebaris kerja pun terjadi. Angka itu memang bukan keputusan penulis Pipeline.

**Lapis 2 — `StructuredOutputError` → StepRun `failed`, `reason: output-invalid`.** Branch dan commit yang terlanjur ada jadi yatim dan dibersihkan GC, persis pola cancel ticket 06.

**Lapis 3 — memakan `attempt` seperti kegagalan lain.** Satu penghitung, `reason` dicatat terpisah — bentuk yang sama dengan lease hilang di ticket 07.

Godaan menjadikannya non-retryable ditolak sadar. Alasan penolakannya bukan konsistensi kosong: kedua lapis itu **bukan intervensi yang sama.** Lapis 1 me-resume session yang **sudah terkontaminasi** keluaran buruknya sendiri; attempt baru adalah **session bersih** — undian yang benar-benar berbeda, bukan pengulangan undian yang sama. Harganya terbatas di muka: `attempts: 2` bawaan berarti satu `run()` tambahan, bukan loop.

### Blok instruksi dibangkitkan Runner, bukan diketik penulis

Mekanisme tag tidak menutup satu lubang: agent tidak tahu tag-nya apa dan bentuknya apa kecuali ada yang memberitahu. **Runner membangkitkan blok instruksi dari `outputs:` dan menempelkannya ke prompt** — inilah pembaca tunggal `description:`.

Alternatifnya, penulis Pipeline mengetik bentuknya sendiri di file prompt, dan itu ditolak karena murni DRY: skema Output lalu hidup di **dua** tempat — di `outputs:` yang divalidasi, dan di kalimat bahasa Inggris di dalam prompt yang tidak divalidasi apa pun. Keduanya akan berbeda suatu hari, dan modenya **diam**: agent menuruti prompt, validator menuruti `outputs:`, StepRun gagal `output-invalid` sementara kedua file terlihat benar.

Konsekuensi yang jatuh gratis: **nama tag tidak pernah diketik siapa pun**, jadi ia konstanta sistem (`<factory-output>`) — tidak perlu bidang YAML untuk sesuatu yang tidak punya pembaca. Step tanpa `outputs:` dan tanpa `ask:` tidak dapat blok itu sama sekali; nol jejak di prompt, sesuai pola ticket 09 di mana Step non-interaktif tidak menulis satu pun bidang HITL.

**Harga yang diakui**: prompt yang sampai ke agent bukan lagi verbatim isi file. Ticket 08 mengunci Run menyimpan salinan isi semua file prompt; supaya janji itu tidak bocor, **yang ditampilkan UI adalah prompt final yang dikirim**, bukan hanya file aslinya.

### `outputs:` hanya untuk Step ber-agent

Step `run:` (perintah shell, tanpa agent) **tidak boleh menulis `outputs:`** — satu klausa lagi di tempat yang sama dengan `agent:/prompt:/promptFile:` XOR `run:` milik ticket 09.

Menerapkan aturan ekstraksi yang sama ke stdout perintah shell menggoda, dan `extractStructuredOutput` **tidak diekspor** dari `src/index.ts` (hanya `Output` dan `StructuredOutputError`), jadi harganya implementasi **kedua** atas aturan yang sama — dan dua implementasi satu aturan adalah persis kelas drift senyap yang ticket 12 sudah bayar contract test untuknya. YAGNI dan DRY menunjuk arah yang sama, jadi berhenti di sini. Menambahkannya aditif: satu cabang di validator, satu ekstraktor kecil di Runner.

Konsekuensi mekanis gratis: **Step `run:` tidak akan pernah bisa jadi sumber fan-out**, tanpa perlu aturan terpisah untuk melarangnya.

### `branchesFrom` diperiksa saat validasi definisi

Sub-pertanyaan 6 memilih opsi pertama, dan ia ternyata gratis. `branchesFrom.step` selalu menunjuk Step **di file yang sama** — satu file satu Pipeline (ticket 08) — jadi skema Output hulu selalu terbaca saat validasi, tanpa satu pun resolusi lintas file.

Yang ditegakkan: Step yang jadi sumber `branchesFrom` **wajib** punya `outputs:`, dan Output yang dirujuk wajib `type: array` dengan `items:` berupa objek yang memuat `key: string`. Ini menumpang jalur ticket 08 apa adanya — mengikat di control plane saat trigger, dengan PR check dan editor sebagai umpan balik awal dari skema Zod yang sama. Tidak ada mekanisme baru.

### Konsekuensi ke ticket lain

- **14 (closed)** — lubang "lewat apa isi Question sampai ke Runner" terisi: tag yang sama, lengan `question`. Bukan koreksi; 14 menolak JSONL dan stdout bukan JSONL.
- **09 (closed)** — notasi `outputs:` di `d-verdict/` diformalkan, `description:` ditambahkan. File prototype dibiarkan apa adanya sebagai artefak bertanggal; **ticket ini yang jadi otoritas** untuk bentuk `outputs:`.
- **24 (open)** — mewarisi dua hal. (a) `{ title, body }` untuk `kind: pull-request` sekarang dua field level atas Output hulu, dirujuk dengan bentuk `{ step, output }` yang sama, dan ikut pemeriksaan statis di atas. (b) **Aturan "`outputs:` hanya untuk Step ber-agent" berarti Step control-plane juga tidak bisa mendeklarasikannya** — kalau `kind: pull-request` perlu memancarkan URL PR ke hilir, ticket 24 harus memutuskan jalannya. Ini diserahkan, bukan dijawab.
- **13 (open)** — panel Output punya jaminan render: selalu tabel, sarang maksimal satu tingkat, nol komponen rekursif.
- **17 (open)** — giliran percakapan tiba lewat lengan `question` dari tag yang sama; prototype boleh memodelkan giliran sebagai persis bentuk itu.
- **21 (open)** — bagian data dari Output sebuah Join lintas repo sekarang sepenuhnya terspesifikasi, jadi sub-pertanyaan 5 menyusut jadi **hanya soal Ref**.
