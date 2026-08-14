# Prototype: bentuk konkret file definisi pipeline

Type: prototype
Status: resolved
Blocked by: 06, 08

## Question

Definisi pipeline itu kelihatan seperti apa kalau ditulis sungguhan — dan apakah bentuknya masih enak dibaca setelah semua keputusan fan-out, join, dan kebutuhan worker ikut masuk?

Diskusi soal skema selalu terasa benar sampai file sungguhannya ditulis. Ticket ini menaikkan resolusi diskusi dengan membuat artefak konkret untuk direaksi.

Tulis **tiga file kandidat yang berbeda gaya** untuk pipeline acuan yang sama (`plan → {agent A, B, C} → pick-best → test`), lalu bahas mana yang paling jelas:

1. Gaya menyerupai GitHub Actions — step bernama dengan `needs:`.
2. Gaya menyerupai Argo/Temporal — daftar task dengan dependensi eksplisit dan templat yang bisa dipakai ulang.
3. Gaya yang paling sedikit basa-basi — apa pun yang muncul kalau ditulis hanya untuk kasus ini, tanpa meniru siapa pun.

Tiap kandidat harus benar-benar memuat, bukan menyembunyikan: kebutuhan worker (docker versus host, label), pilihan agent dan referensi prompt, cara cabang menerima nama branch dari langkah sebelumnya, kebijakan kegagalan sebagian, dan batas waktu.

**Ditambahkan oleh ticket 14** — pipeline acuan wajib ditambah **satu step interaktif**, karena bidang-bidang HITL adalah yang paling mungkin membuat sebuah gaya runtuh: `ask:` (sasaran audiens), `onReject:`, `humanTimeout:`, dan `onHumanTimeout:`. Jadikan acuannya `plan → {agent A, B, C} → pick-best → review(manusia) → test`. Dua hal yang harus terlihat jelas di ketiga kandidat, dan keduanya adalah pemisahan yang ticket 14 tuntut secara tegas:

- **`humanTimeout` terpisah dari batas waktu step agent.** Kalau sebuah gaya memaksa keduanya memakai satu bidang `timeout:`, gaya itu gagal.
- **`onReject` terpisah dari kebijakan kegagalan.** Penolakan manusia bukan kegagalan step; kalau sebuah gaya menyatukannya dengan `onFailure`/`continueOn`, gaya itu gagal.

Lalu uji ketiganya dengan pipeline kedua yang bentuknya berbeda — misalnya rantai lurus tanpa fan-out sama sekali — untuk melihat mana yang tetap ringkas pada kasus sederhana. Pastikan pada kasus sederhana itu step non-interaktif **tidak** dipaksa menuliskan bidang HITL apa pun; semuanya punya bawaan.

**Ditambahkan oleh ticket 08** — sebagian ruang gerak ticket ini sudah menyempit, dan itu justru membuat perbandingan gayanya lebih tajam. Yang sudah dikunci dan **tidak** boleh dipertanyakan lagi oleh kandidat mana pun:

- **YAML**, satu file satu Pipeline, dengan `version: 1` di dalamnya.
- **Tanpa ekspresi sama sekali** — tidak ada `if`, tidak ada pemanggilan fungsi, tidak ada interpolasi yang dievaluasi. Semua nilai konstanta atau rujukan langsung ke Output. Bentuk `ask: role("reviewer")` yang ditulis ticket 14 sudah dikoreksi jadi `ask: { group: reviewer }`.
- **Satu Step menyentuh satu repo.** Kerja lintas repo ditulis sebagai fan-out ber-Key nama repo.
- **Tanpa `uses:`** — tidak ada blok yang dipakai ulang lintas file.

Dua muatan baru yang wajib ikut termuat, dan keduanya adalah tempat sebuah gaya paling mungkin runtuh:

- **Tiap Step menyatakan repo mana yang ia sentuh**, dan itu harus tetap ringkas untuk Pipeline satu repo — kalau sebuah gaya memaksa setiap Step menuliskan nama repo padahal seluruh Pipeline cuma menyentuh satu, gaya itu berisik.
- **Pipeline acuan ketiga: lintas repo.** Tambahkan `plan → {frontend, backend} → join` di samping dua acuan yang sudah ada, supaya terlihat bagaimana fan-out ber-repo dan pemilihan repo per Step terbaca dalam satu file.

Simpan di `docs/design/distributed-software-factory/prototypes/pipeline-format/` dan tautkan dari sini. Ini artefak sekali pakai untuk mengambil keputusan, bukan kode yang dipelihara.

## Answer

Artefak: [`prototypes/pipeline-format/`](../prototypes/pipeline-format/README.md) — tiga gaya × tiga pipeline acuan, plus gaya keempat hasil sintesis. Yang dipilih adalah **`d-verdict/`: rangka gaya A, cabang gaya C.** Tidak satu pun dari ketiga gaya asli menang utuh, dan itu jawaban yang cuma bisa muncul setelah file sungguhannya ditulis.

### Gaya A runtuh jadi YAML yang tidak valid

Temuan paling keras ticket ini, dan ia mekanis, bukan selera. Gaya GitHub Actions memaksa `over:` punya **dua bentuk**: mapping saat sumbernya Output (`over: { fromOutput: ... }`), sequence saat sumbernya konstanta (`over: [ {key: ...}, ... ]`). Bidang `overrides:` — yang ada semata untuk menahan substitusi elemen supaya tidak menjadi ekspresi — tidak punya tempat yang sah di bentuk kedua. [`a-gha/03-cross-repo.yaml`](../prototypes/pipeline-format/a-gha/03-cross-repo.yaml) sengaja dibiarkan gagal parse sebagai bukti; delapan file lain parse bersih.

Akarnya: `over.overrides` adalah bidang yang menjelaskan bidang lain. Itu bau yang terbaca sejak file pertama, dan file ketiga yang membuatnya fatal.

### Dua tempat semua gaya diuji

Keduanya tidak terlihat saat ticket ini ditulis, dan keduanya lahir dari tabrakan dua ticket yang sudah resolved:

**1. Rujukan Output tanpa ekspresi.** Ticket 06 menulis `over: ${{ plan.variants }}`; ticket 08 melarang interpolasi yang dievaluasi. Bentuk itu **mati**, dan ini koreksi terhadap ticket 06 yang harus dicatat.

**2. Cabang yang berbeda agent.** Acuan `{agent A, B, C}` menuntutnya, tapi tanpa ekspresi elemen `over:` tidak bisa disubstitusikan ke bidang `agent:` — kalau bisa, itu interpolasi dengan nama lain. Inilah yang memisahkan ketiga gaya, dan yang menentukan bentuk `over:`.

### Empat keputusan

**Cabang adalah daftar Step, bukan substitusi ke satu Step.** `branches:` berisi Step utuh per cabang; bidang di level Step jadi bawaan semua cabang. "Cabang beda agent" selesai tanpa satu pun mekanisme baru — sebuah cabang adalah Step, Step punya `agent:`, selesai. Konsekuensi gratis: `repo:` per cabang jadi bidang Step biasa, jadi fan-out ber-Key nama repo dari ticket 08 terbaca tanpa alat bantu. Gaya B menjawab pertanyaan yang sama lewat `templates:` di dalam file — ditolak karena tiga blok yang beda satu baris adalah duplikasi yang penolakan `uses:` justru dimaksudkan menghindari, dan karena ia menuntut lompat dua tempat untuk membaca satu Step.

**Dependensi selalu ditulis eksplisit (`after:`), urutan file murni kosmetik.** Gaya C mengusulkan bawaan "step sebelumnya di daftar" — itu yang membuat rantai lurus nol basa-basi, dan itu juga yang ditolak. Urutan tulisan menjawab dua pertanyaan sekaligus: bagaimana file dibaca manusia, dan bagaimana Graph tersusun. Itu bentuk yang sama dengan akar kelas bug `continueOn` yang ticket 02 peringatkan. Harganya dinyatakan di muka: [`d-verdict/02-linear.yaml`](../prototypes/pipeline-format/d-verdict/02-linear.yaml) membayar dua baris `after:` yang isinya "yang sebelumnya", dan rantai lurus kemungkinan bentuk yang paling sering ditulis.

**`steps:` mapping bernama, bukan sequence ber-`id`.** Ini jatuh keluar dari keputusan sebelumnya: begitu urutan kosmetik, sequence tidak punya alasan. Id duplikat jadi **mustahil ditulis** — ditegakkan YAML, bukan validator. Harga yang diterima: file punya dua bentuk koleksi, karena `branches:` tetap sequence (Key-nya memang berurut dan memang divalidasi, sesuai ticket 06).

**Rujukan Output berbentuk data, bukan string bertitik.** `branchesFrom: { step: plan, output: variants }`, bukan `branchesFrom: plan.variants`. Satu parser nilai sudah cukup untuk membuat "tanpa ekspresi" jadi aturan yang ditegakkan selera dan bukan bentuk — dan ia membawa serta pertanyaan escape untuk nama ber-titik. Tiga baris untuk satu rujukan diterima sebagai harga dinding yang utuh.

### Bidang yang lolos uji ticket 09

- **`humanTimeout` terpisah dari `timeout`.** Beda nama, beda baris, tidak pernah bisa tertukar. `timeout:` adalah jam agent **per giliran**; ticket 14 sudah menjamin StepRun `awaiting-human` tidak punya lease, jadi keduanya tidak pernah berjalan bersamaan.
- **`onReject` terpisah dari kebijakan kegagalan.** Ia duduk bersama `ask:`, jauh dari `attempts:` dan `join:`. Penolakan manusia tidak pernah terbaca sebagai kegagalan step.
- **Step non-interaktif tidak menulis satu pun bidang HITL.** Semuanya punya bawaan.
- **Pipeline satu repo tidak menulis `repo:` di level Step sama sekali** — hanya sekali di level Pipeline. Hanya Pipeline lintas repo yang membayar, dan hanya di cabang yang memang berbeda.
- **`unschedulableAfter` milik Pipeline**, bukan Step (ticket 06).
- **`join:` milik Step Join** (`all` bawaan / `any` / `{min: N}`), `minBranches:` milik sisi fan-out (ticket 06).

### Yang diserahkan ke skema Zod, karena YAML tidak menegakkannya

`branches:` XOR `branchesFrom:`; `agent:`/`prompt:`/`promptFile:` XOR `run:`; `prompt:` XOR `promptFile:`; `key` unik di dalam `branches:`; `after:` menunjuk id yang ada dan Graph-nya asiklik; `onHumanTimeout:` hanya bermakna kalau `humanTimeout:` bukan `none`.

### Yang sengaja tidak ditulis di mana pun

`on:` / trigger — itu milik ticket 22 yang masih terbuka. Prototype ini tidak berpura-pura menjawabnya.

### Konsekuensi ke ticket lain

- **06** — bentuk `over: ${{ plan.variants }}` **dikoreksi** jadi `branchesFrom: { step, output }`. Semantiknya utuh; hanya notasinya yang berubah, dan perubahan itu dituntut larangan ekspresi ticket 08.
- **21** — [`d-verdict/03-cross-repo.yaml`](../prototypes/pipeline-format/d-verdict/03-cross-repo.yaml) menunjukkan lubang Join lintas repo terbaca jelas di file: `open-prs` mewarisi `repo: infra` dan hanya membaca manifest. Ticket 21 sekarang punya bentuk konkret untuk mulai, bukan deskripsi.
- **23 (baru)** — notasi kontrak `outputs:` dipakai di ketiga acuan sebagai bahasa tipe mini yang dikarang di tempat (`type: array` + `items:`). Ticket 05 mengunci bahwa Output adalah data tervalidasi skema, tapi tidak notasinya. Itu sekarang pertanyaan tajam tersendiri.
