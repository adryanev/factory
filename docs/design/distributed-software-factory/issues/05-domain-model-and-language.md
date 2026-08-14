# Domain model dan ubiquitous language

Type: grilling
Status: resolved
Blocked by: 00

## Question

Apa saja kata benda dalam sistem ini, apa arti persisnya masing-masing, dan mana yang jadi batas konsistensi?

Ini ticket fondasi — hampir semua ticket lain memakai istilah yang ditetapkan di sini. Pakai `/grilling` dan `/domain-modeling`.

Yang harus dipatok:

1. **Pipeline versus PipelineRun** — Pipeline itu definisi (template), Run itu satu eksekusi. Apakah Run menyimpan salinan definisi saat dijalankan, atau menunjuk ke versi definisi? Yang pertama membuat run bisa dibaca ulang bertahun-tahun kemudian; yang kedua lebih hemat.
2. **Step versus StepRun** — sama, dan tambahan: sebuah step yang di-fan-out menghasilkan berapa StepRun, dan bagaimana masing-masing dibedakan.
3. **Apa keluaran sebuah step** — nama branch? commit SHA? structured output JSON dari agent? gabungan? Ini kata benda yang paling menentukan bentuk seluruh sistem, karena inilah yang mengalir di sepanjang DAG.
4. **Worker versus Runner versus Agent** — "agent" sudah dipakai sandcastle untuk Claude Code/Codex/Cursor. Kita butuh kata yang berbeda untuk mesin yang mendaftar. Patok sekarang sebelum ambigu ini menyebar ke kode dan UI.
5. **Repository / Project** — apa unit yang dimiliki sebuah pipeline. Bisakah satu pipeline menyentuh lebih dari satu repo?
6. **Aggregate dan batas konsistensi** — mana yang harus konsisten dalam satu transaksi. Dugaan awal: PipelineRun beserta seluruh StepRun-nya adalah satu aggregate, karena keputusan penjadwalan membaca status semua saudaranya. Worker adalah aggregate terpisah. Uji dugaan ini.
7. **Status** — daftar tertutup status untuk Run, StepRun, dan Worker, serta transisi mana yang sah. Buat status tidak sah mustahil ditulis.
8. **Siapa pemiliknya** — apakah Run punya pemilik (user yang memicunya), dan apakah kepemilikan itu yang menentukan credential mana yang dipakai. Kalau ya, catat — ticket 10 bergantung padanya.

Keluaran: bagian ubiquitous language dalam spec, plus diagram aggregate. Rekam sebagai ADR kalau `/domain-modeling` menyarankan.

## Answer

Ubiquitous language ditulis ke [`CONTEXT.md`](../../../CONTEXT.md) di akar repo. Keputusan strukturalnya:

**Apa yang mengalir di sepanjang Graph** — satu **Ref** (nama Branch + commit SHA) ditambah **data terstruktur** yang tervalidasi skema. Sandcastle sudah punya structured output extraction, jadi bagian data nyaris gratis. Konsekuensi terbesarnya: **fan-out boleh dinamis** — sebuah Step dapat menghasilkan daftar item, dan sistem melahirkan satu cabang per item.

**Output versus Artifact** — dua benda yang berbeda, dan pemisahan ini yang menjaga model tetap kecil. *Output* adalah yang mengalir ke Step berikutnya dan karena itu harus punya kontrak. *Artifact* adalah yang tertinggal untuk dibaca manusia — transkrip, diff, markdown, keluaran perintah — dan tidak dikonsumsi siapa pun, jadi tidak butuh kontrak. Ticket 15 merancang Artifact di atas pemisahan ini.

**Identitas cabang fan-out** — StepRun bersaudara dibedakan oleh **Key** yang bermakna, berasal dari data yang melahirkannya, bukan oleh indeks urutan. Key ikut ke nama Branch (`run-42/agent-rewrite`), ke log, dan ke UI. Harganya: kontrak fan-out mengharuskan keluaran berupa daftar berkunci, dengan kunci yang unik dan aman dipakai sebagai nama branch. Itu dibayar sekali, dan dibaca ribuan kali.

**Run menyimpan salinan penuh definisi** — teks definisi apa adanya saat Run dipicu, ditambah Graph ter-materialisasi miliknya sendiri. Graph dimiliki Run, bukan Pipeline, karena sebagian simpulnya baru lahir saat Run berjalan. Definisi berukuran kilobyte sementara log satu Run bisa megabyte, jadi biayanya sepele. Riwayat Run adalah jejak audit dan tidak boleh rusak karena ada yang force-push atau menghapus branch.

**Principal** — Run dipicu oleh **User** atau **ServiceAccount**, keduanya adalah Principal, dan credential menempel ke Principal, tidak pernah ke Run. Dipicu manusia berarti memakai credential orang itu, sehingga isolasi antar user terjaga dan biaya tercatat atas namanya. Dipicu Automation berarti memakai ServiceAccount milik Project dengan izin yang sengaja dibatasi. Ini menyelesaikan tabrakan antara "isolasi credential antar user" dan "trigger otomatis" yang keduanya sudah masuk scope.

**Project adalah unit isolasi** — anggota, peran, credential, secret, ServiceAccount, Pipeline, dan Repository menempel padanya. Repository adalah anggota Project, bukan pemiliknya, dan satu Pipeline boleh menyentuh beberapa Repository di dalam Project-nya. Batas keamanan berhenti di Project: ini jawaban atas "apa yang mencegah pipeline repo A membaca secret repo B" di ticket 10.

**Batas aggregate** — **Run adalah aggregate untuk keputusan penjadwalan**: klaim StepRun, penyelesaian StepRun, kelahiran cabang fan-out, evaluasi kesiapan, dan penutupan Run semuanya lewat satu transaksi yang mengunci Run. Aturan Graph jadi mudah dinalar dan bebas balapan. Tulisan berfrekuensi tinggi — potongan log, heartbeat, progres token — menulis langsung ke StepRun **di luar** transaksi itu, sehingga Runner yang cerewet tidak pernah memblokir penjadwalan. **Runner adalah aggregate terpisah.**

**Status** — diturunkan dari keputusan di atas, dipatok tanpa pertanyaan terpisah:

- **Run**: `pending` → `running` → `succeeded` | `failed` | `cancelled`
- **StepRun**: `pending` (dependensi belum selesai) → `ready` (bisa diklaim Runner) → `running` → `awaiting-human` ⇄ `running` → `succeeded` | `failed` | `cancelled` | `skipped`
- **Runner**: `online` | `offline` | `draining` | `disabled`

Dua pilihan di dalamnya yang layak dibantah kalau salah rasa: `awaiting-human` adalah status StepRun tersendiri, bukan varian dari `running` — konsisten dengan keputusan bahwa Interactive Step adalah kelas satu, dan dengan temuan ticket 00 bahwa menambal ini belakangan tidak berhasil. Dan kehabisan waktu **bukan** status tersendiri; ia adalah `failed` yang membawa alasan, supaya daftar status tetap pendek.

"Menunggu manusia" tidak dijadikan status Run karena ia turunan: pertanyaan yang sebenarnya orang ajukan adalah "apa yang menunggu **saya**", dan itu kueri atas Question, bukan atas Run.

**Penamaan** — mesin yang mendaftar disebut **Runner**, bukan Worker. "Worker" ambigu antara mesin, proses, dan thread; owainlewis/factory memakainya untuk dua hal sekaligus. **Agent** dipesan khusus untuk AI coding agent, mengikuti sandcastle. Eksekusi sebuah Pipeline disebut **Run**, bukan PipelineRun, karena StepRun sudah membawa pembedanya.

Konsekuensi ke ticket lain: 06 (semantik fan-out dinamis, penamaan Branch dari Key, kontrak join), 07 (Runner sebagai aggregate terpisah, status Runner), 08 (Run menyimpan salinan definisi — mempengaruhi cerita versioning), 10 (Principal memegang credential, Project sebagai batas secret), 11 (Principal, Project, peran), 14 (Question sebagai entitas durable, status `awaiting-human`), 15 (pemisahan Output dan Artifact), 16 (kontinuitas antar Run lewat Artifact bernama).
