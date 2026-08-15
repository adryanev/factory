Spec ini menjahit 29 ticket desain di `docs/design/distributed-software-factory/` jadi satu dokumen siap implement. Setiap keputusan di bawah sudah punya alasan tertulis di ticket-nya; yang ada di sini adalah **apa yang dibangun**, bukan pengulangan **kenapa**. Glossary domain mengikat: lihat `CONTEXT.md`.

## Problem Statement

Sebuah tim internal menjalankan sebagian besar pekerjaan pengembangan lewat AI coding agent, tetapi tidak punya tempat untuk **menjalankan alur itu sebagai satu proses yang terlihat**.

Yang dirasakan hari ini:

- Agent dijalankan satu per satu di laptop masing-masing orang. Tidak ada yang tahu apa yang sedang berjalan di mesin siapa, dan mesin yang menganggur tidak bisa dipinjam siapa pun.
- Pekerjaan yang wajar dipecah — "rencanakan, lalu tiga agent mencoba tiga pendekatan, lalu pilih yang terbaik" — harus dijalankan manual, berurutan, dan hasilnya dikumpulkan dengan tangan.
- Langkah yang **butuh manusia** (menyusun product requirement lewat grilling, menyetujui rencana sebelum implementasi) memutus alurnya sama sekali. Alat CI yang ada mengasumsikan tidak ada manusia di dalam pipeline, jadi langkah semacam itu berarti keluar dari alat, mengobrol di tempat lain, lalu masuk lagi.
- Ketika sesuatu selesai, tidak ada rekaman yang bisa dibuka: apa yang agent baca, apa yang ia tulis, berapa biayanya, dan siapa yang menyetujui apa.
- Credential agent dan token repo berserakan di mesin pribadi. Tidak ada isolasi antar orang dan antar proyek, dan tidak ada yang tahu kunci mana masih dipakai.
- Kerja lintas repo (ubah kontrak API, lalu implementasi di frontend dan backend) tidak punya bentuk sama sekali.

Alat yang ada tidak menutupinya. CI biasa tidak punya konsep manusia di tengah pipeline dan tidak punya konsep agent. Orkestrator DAG yang ada tidak punya konsep repo sebagai jalur perpindahan kerja. Tidak ada satu pun kandidat open source yang layak dijadikan basis (ticket 00, dibaca dari source keempatnya).

Dan satu batasan keras: seluruh sistem harus bisa dijalankan sendiri oleh organisasi. Tidak boleh ada ketergantungan pada layanan terkelola yang tidak punya jalur self-host.

## Solution

Sebuah **distributed software factory**: control plane yang menjalankan Pipeline berbentuk graph di atas kolam Runner milik organisasi, dengan web UI untuk memicu, mengawasi, menjawab, dan memeriksa.

Dari sudut pandang orang yang memakainya:

**Pipeline ditulis sebagai satu file YAML di dalam repo.** Ia di-review bersama kode, diuji dengan menjalankan branch PR-nya, dan tidak pernah jadi baris database buram. Editor visual di web adalah generator PR ke file itu, bukan penyimpan kedua.

**Satu Run adalah satu eksekusi Pipeline.** Ia dipicu oleh kejadian git, jadwal, atau tombol. Ia menyimpan salinan penuh definisi yang melahirkannya beserta isi semua file prompt, sehingga tetap terbaca meski definisi aslinya berubah.

**Pekerjaan dibagikan ke Runner terdaftar.** Runner menarik pekerjaan lewat koneksi keluar, jadi laptop di belakang NAT dan Mac mini di bawah meja sama-sama bisa ikut. Satu Step bisa pecah jadi puluhan StepRun yang berjalan serentak di mesin berbeda, lalu bergabung lagi di Join.

**Kode berpindah antar mesin lewat git.** Tiap StepRun commit dan push ke branch bernama; StepRun berikutnya fetch branch itu. Yang mengalir di sepanjang Graph hanya **Output**: satu Ref plus data terstruktur yang tervalidasi skema.

**Langkah yang menunggu manusia adalah kelas satu.** Agent yang perlu bertanya mengakhiri gilirannya, mendorong branch, mengunggah session-nya, lalu menerbitkan Question. StepRun jadi baris database tanpa lease — Sandbox ditutup, Runner bebas, mesin tidak disandera. Manusia menjawab lewat web kapan saja, dari menit sampai hari, dan giliran berikutnya lahir di mesin mana pun yang kosong. Kasus acuannya: menyusun PRD lewat grilling session di dalam web, dengan draf yang tumbuh di sebelah percakapan.

**Setiap StepRun meninggalkan jejak yang bisa dibuka**: log yang bisa ditonton hidup, diff yang dimaterialisasi, transkrip agent, dokumen markdown, biaya token.

**Batas kepemilikan satu kalimat**: factory memiliki segalanya sebelum PR ada, GitHub sejak PR ada. Factory membuka PR dan menempelkan status; ia tidak pernah merge, tidak pernah berkomentar, tidak pernah jadi issue tracker kedua.

## User Stories

**Menulis dan memicu Pipeline**

1. Sebagai developer, saya ingin menulis definisi Pipeline sebagai satu file YAML di dalam repo saya, agar perubahan pipeline ikut di-review bersama kode yang ia jalankan.
2. Sebagai developer, saya ingin definisi dibaca dari ref yang memicunya, agar saya bisa menguji perubahan pipeline dengan menjalankan branch PR-nya sebelum merge.
3. Sebagai developer, saya ingin file yang salah bentuk ditolak dengan pesan yang menunjuk baris, agar saya tidak menemukan kesalahannya baru setelah Run berjalan setengah jalan.
4. Sebagai developer, saya ingin melihat hasil validasi definisi sebagai PR check, agar saya tahu file saya sah sebelum ada yang me-review.
5. Sebagai developer, saya ingin menyusun rantai Step yang berurutan dengan ketergantungan yang ditulis eksplisit, agar urutan tulisan di file tidak pernah diam-diam ikut menentukan urutan eksekusi.
6. Sebagai developer, saya ingin memecah satu Step jadi beberapa cabang yang jumlahnya ditentukan Output langkah sebelumnya, agar "tiga varian implementasi" bisa ditulis tanpa saya tahu di muka ada berapa.
7. Sebagai developer, saya ingin tiap cabang punya Key yang bermakna, agar saya mengenali cabang dari namanya di UI, di log, dan di nama branch — bukan dari indeks.
8. Sebagai developer, saya ingin cabang boleh berbeda agent, berbeda repo, dan berbeda prompt, agar "bandingkan Claude, Codex, dan Cursor pada tugas yang sama" tidak butuh mekanisme baru.
9. Sebagai developer, saya ingin menyatakan sebuah Step sebagai Join yang menunggu semua cabang, atau salah satu, atau minimal N, agar kebijakan kegagalan sebagian saya tulis di tempat ia berlaku.
10. Sebagai developer, saya ingin Join menerima ringkasan seluruh cabang sebagai data, agar saya bisa membaca hasil cabang lain tanpa satu StepRun harus meng-checkout banyak repo.
11. Sebagai developer, saya ingin mendeklarasikan kontrak Output sebuah Step, agar apa yang mengalir ke hilir punya bentuk yang dijamin, bukan teks bebas yang saya harap benar.
12. Sebagai developer, saya ingin instruksi format Output dibangkitkan otomatis dan ditempelkan ke prompt, agar skema tidak hidup di dua tempat dan tidak bisa berbeda diam-diam.
13. Sebagai developer, saya ingin Step yang cuma menjalankan perintah shell ditulis tanpa satu pun bidang yang berhubungan dengan agent, agar file saya tidak penuh bidang yang tidak berlaku.
14. Sebagai developer, saya ingin menyatakan Step ini harus jalan di Runner bertipe tertentu, agar test yang butuh Xcode mendarat di Mac dan bukan di kontainer Linux.
15. Sebagai developer, saya ingin Pipeline saya berjalan otomatis saat ada push atau PR ke path tertentu, agar tidak ada yang perlu menekan tombol untuk alur rutin.
16. Sebagai developer, saya ingin Pipeline saya berjalan pada jadwal, agar pekerjaan malam berjalan tanpa saya.
17. Sebagai developer, saya ingin menekan tombol di web untuk memicu Pipeline atas ref tertentu, agar saya bisa menjalankan sesuatu tanpa membuat commit kosong.
18. Sebagai developer, saya ingin satu commit hanya melahirkan satu Run walau GitHub mengirim beberapa kejadian yang menggambarkannya, agar saya tidak membayar pekerjaan yang sama tiga kali.
19. Sebagai developer, saya ingin Run lama untuk branch yang sama dibatalkan saat saya push lagi, agar tidak ada dua Run yang bersaing menulis ke branch yang sama.
20. Sebagai developer, saya ingin memakai editor visual untuk menyusun Pipeline dan mendapat PR berisi YAML-nya, agar saya bisa mulai dari gambar tanpa kehilangan file sebagai sumber kebenaran.
21. Sebagai developer, saya ingin PR yang dibuat editor tercatat atas nama saya, agar kontribusi saya tetap terhitung meski push-nya dilakukan sistem.

**Mengawasi Run yang berjalan**

22. Sebagai developer, saya ingin melihat Run saya sebagai graph, agar saya bisa menjawab "kenapa ini belum selesai" dengan melihat bentuknya, bukan membaca daftar.
23. Sebagai developer, saya ingin melihat status tiap StepRun dalam bentuk yang berbeda-beda bukan sekadar warna berbeda, agar saya bisa membedakan gagal dari terlewat tanpa membandingkan rona.
24. Sebagai developer, saya ingin fan-out lima puluh cabang diringkas dengan yang gagal ditampilkan lebih dulu, agar satu-satunya cabang bermasalah tidak tersembunyi di balik empat puluh yang sehat.
25. Sebagai developer, saya ingin melihat banner yang menyebut apa yang sedang menahan Run saya, agar saya tahu ke mana harus melihat.
26. Sebagai developer, saya ingin cabang yang gagal di bawah Join yang toleran tidak dipasangi spanduk merah, agar Run yang masih bergerak tidak terlihat rusak.
27. Sebagai developer, saya ingin menonton log sebuah StepRun hidup selagi ia berjalan, agar saya tidak menunggu sampai selesai untuk tahu ia macet.
28. Sebagai developer, saya ingin log tiap cabang punya tab sendiri, agar saya tidak membaca tiga aliran yang diurutkan menurut jam tiga mesin berbeda.
29. Sebagai developer, saya ingin melihat prompt final yang benar-benar dikirim ke agent, agar apa yang saya baca sama dengan apa yang agent baca.
30. Sebagai developer, saya ingin membuka diff yang dihasilkan sebuah StepRun tanpa meng-checkout apa pun, agar saya bisa menilai hasilnya dari browser.
31. Sebagai developer, saya ingin membuka transkrip percakapan agent, agar saya bisa melihat bagaimana ia sampai pada hasilnya.
32. Sebagai developer, saya ingin melihat biaya berjalan selagi Run berjalan di layar yang sama dengan tombol batal, agar saya bisa menghentikan sesuatu yang jelas membakar uang.
33. Sebagai developer, saya ingin membatalkan Run dan melihat layar mengakuinya seketika, agar saya tidak menekan tombol itu tiga kali.
34. Sebagai developer, saya ingin menjalankan ulang sebuah Run dari titik tertentu, agar satu jawaban yang salah di giliran ketiga tidak menuntut mengulang semuanya.
35. Sebagai developer, saya ingin nama branch sebuah StepRun bisa saya salin langsung ke `git checkout`, agar saya bisa melanjutkan pekerjaan agent dengan tangan.
36. Sebagai developer, saya ingin StepRun yang tidak kunjung dapat mesin ditandai setelah beberapa menit, agar "antre" tidak terlihat sama dengan "macet".

**Menjawab sebagai manusia di dalam pipeline**

37. Sebagai reviewer, saya ingin melihat lencana berisi jumlah pertanyaan yang menunggu saya, agar saya tidak perlu membuka setiap Run untuk mengeceknya.
38. Sebagai reviewer, saya ingin halaman berisi semua yang menunggu jawaban saya diurutkan menurut umur, agar yang paling lama tertahan naik ke atas.
39. Sebagai reviewer, saya ingin lencana padam sendiri saat orang lain menjawab atau Run dibatalkan, agar tidak ada notifikasi basi yang harus saya bersihkan.
40. Sebagai reviewer, saya ingin percakapan dan draf dokumen tampil berdampingan, agar saya melihat draf tumbuh sambil saya menjawab.
41. Sebagai reviewer, saya ingin selalu punya kotak teks bebas walaupun agent memberi pilihan, agar jawaban "ya, tapi hanya untuk kasus tertentu" punya tempat.
42. Sebagai reviewer, saya ingin menyunting draf langsung dan suntingan saya ditandai sebagai tulisan manusia, agar riwayatnya terlihat.
43. Sebagai reviewer, saya ingin melihat ringkasan apa yang terjadi selagi saya pergi saat membuka kembali sesi, agar saya tidak membaca ulang delapan puluh giliran.
44. Sebagai reviewer, saya ingin melihat daftar keputusan yang sudah diambil di sesi ini, agar saya tidak menyetujui sesuatu dua kali dengan arah berbeda.
45. Sebagai reviewer, saya ingin menyetujui atau menolak dengan alasan, agar penolakan saya sampai ke agent sebagai bahan, bukan sekadar sebagai kegagalan.
46. Sebagai reviewer, saya ingin sistem mencatat siapa yang menjawab apa, agar "siapa menyetujui ini" selalu punya jawaban.
47. Sebagai reviewer, saya ingin pertanyaan ditujukan ke sebuah grup dan jawaban pertama menang, agar tidak ada satu orang yang jadi sumbatan saat ia cuti.
48. Sebagai reviewer, saya ingin ketikan saya tidak dibuang saat orang lain menjawab lebih dulu, agar kalah 200 milidetik tidak menghapus paragraf yang baru saya tulis.
49. Sebagai reviewer, saya ingin sesi yang menggantung berhari-hari tetap ada setelah control plane di-restart dan setelah saya menutup browser, agar percakapan tidak hilang karena hal yang tidak berhubungan.
50. Sebagai anggota tim, saya ingin channel chat kami mendapat pesan saat ada pertanyaan terbit atau Run gagal, agar tidak ada yang perlu memelototi UI.
51. Sebagai anggota tim, saya ingin fan-out lima puluh cabang menghasilkan satu pesan, bukan lima puluh.
52. Sebagai anggota tim, saya ingin ringkasan harian per Project, agar yang tertahan lama tetap terlihat tanpa pengingat yang menekan.

**Mengoperasikan mesin**

53. Sebagai operator, saya ingin mendaftarkan sebuah mesin ke kolam dengan satu token sekali pakai, agar menambah kapasitas tidak menuntut menyalin credential jangka panjang.
54. Sebagai operator, saya ingin Runner hanya membuat koneksi keluar, agar mesin di belakang NAT dan di rumah orang bisa ikut tanpa membuka port.
55. Sebagai operator, saya ingin kapabilitas mesin diprobe otomatis tiap kali Runner start, agar memasang Claude Code versi baru tidak menuntut saya mendaftarkan apa pun.
56. Sebagai operator, saya ingin menentukan berapa pekerjaan yang boleh dijalankan sebuah mesin sekaligus, agar laptop saya tidak dipakai sampai tidak bisa dipakai.
57. Sebagai operator, saya ingin memberi label pada mesin dan Pipeline meminta label itu, agar pencocokan pekerjaan bisa saya arahkan.
58. Sebagai operator, saya ingin menyuruh sebuah mesin berhenti mengambil pekerjaan baru dan menghabiskan yang dipegangnya, agar saya bisa mematikannya tanpa membunuh pekerjaan.
59. Sebagai operator, saya ingin mencabut sebuah mesin dari kolam seketika saat ia hilang atau dicurigai, agar tulisannya ditolak walau prosesnya masih hidup.
60. Sebagai operator, saya ingin melihat mesin yang versinya terlalu tua ditandai di UI beserta sebabnya, agar mesin yang tidak pernah dapat kerja tidak terlihat sehat.
61. Sebagai operator, saya ingin pekerjaan yang mesinnya mati dijadwalkan ulang otomatis, agar laptop yang ditutup tidak menggantung Run selamanya.
62. Sebagai operator, saya ingin pekerjaan yang gagal berulang berhenti dicoba, agar satu pekerjaan beracun tidak berkeliling membunuh seluruh kolam.
63. Sebagai operator, saya ingin memasang seluruh sistem dengan satu file compose di satu mesin, agar self-host tidak jadi proyek tersendiri.
64. Sebagai operator, saya ingin migrasi database berjalan sekali dan berisik saat terlewat, agar "lupa migrasi" tidak muncul sebagai endpoint yang patah beberapa jam kemudian.
65. Sebagai operator, saya ingin memasang Runner macOS lewat skrip yang bisa saya baca, dan skrip itu memverifikasi isolasi sebelum mesin mendapat identitas, agar instalasi separuh jadi tidak pernah menghasilkan mesin yang diam-diam tidak terlindungi.
66. Sebagai operator, saya ingin backup berupa dump database plus sinkronisasi objek, agar pemulihan tidak menuntut menyalin direktori data yang sedang ditulis.
67. Sebagai operator, saya ingin bahan kunci ada di file dengan tata letak yang membuatnya tidak ikut ter-backup, agar kunci dan ciphertext tidak pernah tersimpan berdampingan.

**Keamanan, akses, dan uang**

68. Sebagai anggota tim, saya ingin login dengan akun GitHub saya, agar tidak ada kata sandi baru.
69. Sebagai admin, saya ingin keanggotaan dan peran ditentukan di sistem kami sendiri, agar identitas GitHub hanya menjawab "siapa kamu" dan tidak pernah "boleh apa".
70. Sebagai admin, saya ingin satu akun break-glass lokal, agar pemadaman GitHub tidak mengunci kami keluar dari tombol batal.
71. Sebagai admin, saya ingin Project jadi batas isolasi, agar Pipeline satu Project tidak pernah bisa melihat secret Project lain.
72. Sebagai admin, saya ingin menyimpan secret Project dan credential agent terenkripsi, agar tidak ada nilai yang bisa dibaca dari database.
73. Sebagai admin, saya ingin merotasi kunci enkripsi tanpa mengganggu Run yang berjalan, agar rotasi tidak jadi hal yang orang hindari.
74. Sebagai admin, saya ingin token repo dibuat sesempit mungkin dan berumur pendek, agar agent yang dibujuk teks jahat tidak memegang kunci ke seluruh organisasi.
75. Sebagai admin, saya ingin agent tidak pernah punya izin membuka PR sendiri, agar satu-satunya jalan kerja keluar dari factory adalah jalur yang kami kendalikan.
76. Sebagai admin, saya ingin agent tidak bisa membaca identitas mesin yang menjalankannya, agar ia tidak bisa naik pangkat jadi Runner.
77. Sebagai admin, saya ingin egress dari sandbox ditolak secara bawaan, agar tujuan yang tidak dikenal tertutup tanpa saya harus menyebutkannya satu per satu.
78. Sebagai admin, saya ingin mode eksekusi langsung di host jadi izin yang saya berikan sadar per Project, agar ia tidak jadi bawaan yang orang pakai tanpa berpikir.
79. Sebagai admin, saya ingin sakelar untuk mematikan semua pemicu otomatis satu Project, agar webhook yang mengamuk bisa dipadamkan tanpa PR ke tiap repo.
80. Sebagai admin, saya ingin catatan audit yang tidak bisa diubah atau dihapus, agar "siapa melakukan apa" tetap terjawab setelah terjadi sesuatu.
81. Sebagai owner organisasi, saya ingin ditolak mengakses data Project yang saya bukan anggotanya, tapi ditawari jalan keluar yang tercatat, agar tidak ada superuser diam-diam dan juga tidak ada jalan buntu.
82. Sebagai anggota tim, saya ingin melihat biaya per Run, per StepRun, dan per giliran, agar saya bisa menilai apakah sebuah pendekatan sepadan.
83. Sebagai anggota tim, saya ingin agent yang tidak melaporkan pemakaian ditampilkan sebagai "tidak didukung", bukan sebagai angka perkiraan, agar saya tidak mengambil keputusan dari angka yang terlihat benar padahal karangan.
84. Sebagai admin, saya ingin biaya dihitung sekali saat pekerjaan berakhir dan disimpan bersama versi harganya, agar mengubah tabel harga tidak menulis ulang sejarah.
85. Sebagai admin, saya ingin melihat biaya yang lahir dari credential bersama secara terpisah dari yang lahir dari credential pribadi, agar pemakaian credential bersama terlihat.

**Kerja lintas repo dan batas dengan GitHub**

86. Sebagai developer, saya ingin satu Project memuat beberapa repo, agar frontend, backend, dan infra hidup di bawah satu batas keamanan yang sama.
87. Sebagai developer, saya ingin menulis Pipeline lintas repo di repo config Project, agar pipeline yang menyentuh banyak repo punya rumah yang jelas.
88. Sebagai developer, saya ingin kerja lintas repo berbentuk fan-out dengan Key nama repo, agar tiap StepRun tetap menyentuh satu repo saja.
89. Sebagai developer, saya ingin factory membuka PR di tiap repo yang tersentuh, agar hasil kerja berakhir di tempat tim saya sudah bekerja.
90. Sebagai developer, saya ingin judul dan isi PR datang dari Output langkah sebelumnya, agar PR yang dibuka menjelaskan dirinya.
91. Sebagai developer, saya ingin melihat status Run menempel di commit sebagai check, dengan tautan kembali ke halaman Run.
92. Sebagai developer, saya ingin factory tidak pernah merge dan tidak pernah berkomentar di issue saya, agar ia tidak jadi alat kedua yang harus saya awasi.
93. Sebagai developer, saya ingin PR dari fork diabaikan seluruhnya, agar orang luar tidak bisa menjalankan definisi mereka di mesin kami.
94. Sebagai developer, saya ingin Run dibatalkan otomatis saat branch-nya dihapus atau PR-nya ditutup, termasuk yang sedang menunggu manusia.

## Implementation Decisions

### Bentuk sistem

Monorepo pnpm TypeScript dengan empat paket: **control-plane** (REST di atas Zod), **runner** (CLI yang mengimpor sandcastle), **web** (React + Vite), **shared** (skema Zod dipakai ketiganya, sekaligus paket workspace yang runner impor). Postgres 15+. Object storage: **Garage**, versi di-pin eksak.

Runner mengimpor `@ai-hero/sandcastle` dengan **versi di-pin eksak, bukan range**. Seluruh pemakaiannya diisolasi di satu direktori agent-runtime yang jadi satu-satunya importir, mengekspor satu fungsi `startTurn(spec) → { done, cancel() }`. Fork ditolak. `pnpm patch` adalah katup untuk perubahan kecil; patch yang membengkak adalah pemicu berbasis bukti untuk meninjau ulang.

Provider Docker bawaan sandcastle dipakai apa adanya. Provider host **ditulis sendiri** dan didaftarkan dengan tag bind-mount — tag "none" mematikan session capture secara senyap, dan tanpa itu step interaktif patah tanpa suara di Runner macOS.

Cancel dibangun **di luar** sandcastle: docker lewat network per-StepRun lalu stop dengan grace period; host lewat sinyal ke process group. Jam sandcastle (idle/completion) dibiarkan aktif karena ia mengukur agent menggantung, bukan wall-clock; **jam wall-clock hanya satu dan dipegang control plane**.

### Definisi Pipeline

Data murni, YAML, satu file satu Pipeline, `version: 1`, **tanpa ekspresi**. TypeScript ditolak: ia berarti mengeksekusi kode asing di control plane. Identitas Pipeline adalah **repo tuan rumah + path file**, tanpa id dan tanpa pendaftaran — jadi tidak ada tabel `pipelines`, dan rename berarti Pipeline baru.

Bentuknya, dari prototype yang menang (rangka gaya GitHub Actions, cabang gaya minimal):

```yaml
version: 1
name: Rencana, tiga varian, review manusia
repo: backend                 # bawaan Pipeline; Step dan cabang boleh menimpa
unschedulableAfter: 2h

steps:                        # mapping bernama: id duplikat mustahil ditulis
  plan:
    promptFile: .factory/prompts/plan.md
    timeout: 30m
    outputs:
      variants:
        type: array
        items: { key: string, brief: string }

  implement:
    after: [plan]             # selalu eksplisit; urutan file kosmetik
    branchesFrom: { step: plan, output: variants }   # XOR `branches:` konstanta
    minBranches: 1
    promptFile: .factory/prompts/implement.md
    runsOn: [exec:docker]
    timeout: 45m
    attempts: 2

  review:
    after: [implement]
    join: all                 # all (bawaan) | any | { min: N } — milik Join
    promptFile: .factory/prompts/review.md
    ask: { group: reviewer, kind: approval }   # kehadirannya membuat Step interaktif
    onReject: fail            # fail | continue (bawaan)
    humanTimeout: 7d          # none (bawaan)

  open-pr:
    after: [review]
    kind: pull-request        # Step control-plane; tak pernah diklaim Runner
    base: main
    title: { step: review, output: prTitle }
    body:  { step: review, output: prBody }
```

Yang ditegakkan skema Zod karena YAML tidak menegakkannya: `branches:` XOR `branchesFrom:`; `agent:`/`prompt:`/`promptFile:` XOR `run:`; `prompt:` XOR `promptFile:`; Key unik di dalam `branches:`; `after:` menunjuk id yang ada dan Graph-nya asiklik; `onHumanTimeout:` hanya bermakna bila `humanTimeout:` bukan `none`; `outputs:` **hanya** untuk Step ber-agent; `timeout:`/`attempts:` **ditolak** pada Step ber-`kind:`; `after:` yang menunjuk Step `kind: pull-request` adalah **error** (ia daun); Join di hilir fan-out ber-repo **wajib** menulis `repo:` eksplisit; Step sumber `branchesFrom` wajib punya `outputs:` bertipe array of object yang memuat `key: string`.

Validasi **mengikat hanya di control plane saat trigger**. PR check dan editor visual adalah umpan balik awal dari skema Zod yang sama.

Fan-out **hanya satu jalur, semuanya dinamis atau konstanta eksplisit** — tidak ada `parallelism: N`. Key ditulis eksplisit per elemen dan bertipe berkendala `[a-z0-9][a-z0-9._-]{0,63}`; duplikat menggagalkan Run saat fan-out. Normalisasi slug ditolak: cek duplikat berjalan sebelum normalisasi, jadi `Frontend`/`frontend` akan lolos lalu bertabrakan di remote.

**Submodule dideklarasikan, tidak dideteksi.** Step yang checkout-nya menuntut repo kedua menulis `submodules: [migrations]` — nama `Repository` anggota Project, bukan URL. Deklarasi inilah **satu-satunya** sumber untuk mint token baca; membaca `.gitmodules` sebagai sumber berarti siapa pun yang bisa menulis file itu di sebuah branch memperlebar token repo-nya sendiri. Skema menolak repo yang bukan anggota Project yang sama, dan Runner **membandingkan deklarasi dengan `.gitmodules` setelah checkout** lalu menggagalkan StepRun dengan pesan yang menyebut nama submodule — tanpa itu deklarasi yang basi muncul sebagai direktori kosong dan gagal jauh di hilir. Namanya sengaja sempit: `reads:` akan membuka pelonggaran lintas-repo umum lewat pintu belakang penamaan.

`minBranches: 0` sah dan berarti "cabang boleh nol" — dipakai untuk pekerjaan di repo kedua yang baru diketahui perlu di tengah jalan, yang mengalir sebagai `outputs:` Step hulu (mis. `{ path, content }` file migrasi) ke Step ber-`repo:` lain.

**Manifest Join hadir sebagai file di dalam checkout**, bukan hanya sebagai konteks agent, supaya Step `run:` di hilir Join bisa membacanya tanpa satu pun ekspresi di YAML.

Pasangan berurutan lintas repo — ubah skema di repo submodule, lalu naikkan pointer di repo utama — ditulis sebagai rantai di dalam **satu Pipeline**, dan urutan merge-nya ditegakkan di dalam Run, bukan diserahkan ke manusia setelah PR ada: Step penaik pointer (sebuah Step `run:`) menunggu Question `approval` sampai PR repo submodule di-merge, lalu menaikkan pointer ke SHA **`main`** repo itu — bukan ke SHA branch, yang squash merge akan buat tak terjangkau. Menggantung di situ gratis: `awaiting-human` tidak memegang lease. Konsekuensi yang ikut dinamai di sini: **`ask:` pada Step non-agent berarti gerbang sebelum eksekusi** — Question diterbitkan control plane dan Step-nya tidak pernah diklaim Runner sampai dijawab, berbeda dari Step ber-agent yang bertanya di tengah gilirannya sendiri.

`uses:` (blok definisi yang dipakai ulang) ditunda; penambahannya aditif murni.

### Kontrak Output

Agent memancarkan Output sebagai **tag XML tunggal di stdout** — mekanisme sandcastle, bukan pilihan kita. Notasi di YAML adalah bahasa tipe mini sendiri: level atas mapping nama → deskriptor; deskriptor `{ type: <skalar> }` atau `{ type: array, items: <skalar> | <objek datar> }`; skalar ∈ `string | number | boolean`; objek datar tanpa sarang; semua field wajib; `description:` opsional dan punya tepat satu pembaca. JSON Schema ditolak karena kita tetap harus menulis validator yang menolak sebagian besar permukaannya.

Karena sandcastle menerima **satu tag per `run()`**, skema yang dikompilasi adalah **union terdiskriminasi**:

```
<factory-output> {"kind":"question", ...}              → Runner POST Question
<factory-output> {"kind":"done","outputs":{ ... }}     → Output mengalir ke hilir
```

Step tanpa `ask:` hanya punya lengan `done`. Step dengan `ask:` **selalu** dapat definisi output walau `outputs:`-nya kosong — tanpa tag, "bertanya" dan "selesai" tidak bisa dibedakan.

Blok instruksi format dibangkitkan **Runner** dari `outputs:` dan ditempelkan ke prompt. Nama tag adalah konstanta sistem dan tidak pernah diketik siapa pun. Konsekuensinya: prompt yang sampai ke agent bukan lagi verbatim isi file, jadi **UI menampilkan prompt final yang dikirim**.

Validasi terjadi di **dua tempat dengan dua alasan**: Runner lebih dulu (gratis, dan hanya di sini session masih hidup sehingga perbaikan-diri agent mungkin), control plane sebagai **gerbang otoritatif** (Output satu-satunya hal yang menggerakkan penjadwalan). Skemanya satu, dikompilasi dari definisi yang sama. Output yang ditolak → StepRun `failed` dengan `reason: output-invalid`, memakan `attempt` biasa.

### Semantik eksekusi

Status StepRun: `ready` · `running` · `awaiting-human` · `succeeded` · `failed` · `skipped` · `cancelled`. `skipped` berarti tidak pernah dijalankan karena keputusan Graph, dan menyebar ke hilir.

**Hanya `step_run.outcome` yang disimpan selagi Run bergerak.** "Hilir dijadwalkan" dan vonis akhir Run dihitung — satu bidang yang menjawab dua pertanyaan adalah akar kelas bug yang kita hindari. Konsekuensi yang diterima sadar: **Run bisa `succeeded` walau ada StepRun `failed`**.

Pengecualian bernalar: `runs.outcome` dan `runs.ended_at` nullable, **ditulis sekali** oleh transaksi yang mengakhiri Run, karena vonis akhir tidak bisa berubah lagi setelah Run berakhir. Jalur penjadwalan tidak pernah membacanya. `ended_at` sekaligus predikat yang dituntut keempat sweep retensi.

Satu penghitung `attempt` untuk semua sebab kegagalan (termasuk lease hilang dan `output-invalid`), dengan `reason` dicatat terpisah. Bawaan `attempts: 2`. Retry **menimpa baris yang sama**.

**Giliran melahirkan baris StepRun baru; `attempt` menghitung ulang di dalamnya.** Dua penomoran terpisah: retry policy membaca `attempt` saja.

Graph dimaterialisasi **hibrida** — Step non-fan-out di muka, cabang saat hulu sukses — dalam **satu transaksi Postgres**. `ready` digerakkan kejadian, dengan sweep berkala sebagai jaring pengaman.

Tidak ada Runner yang cocok = **antre dan ditandai UI setelah 5 menit**, bukan gagal. `minBranches` bawaan 1 menutup jebakan "`all` atas himpunan kosong bernilai benar". **`minBranches: 0` yang ditulis eksplisit membalik itu dengan sengaja**: nol cabang berarti Join **sukses dan hilirnya tetap dijadwalkan**, bukan `skipped` — tanpa pengecualian ini, jalur "ternyata tidak ada pekerjaan di repo kedua" ikut mematikan seluruh hilirnya, termasuk Step yang membuka PR. Cabang `awaiting-human` tidak menahan cabang lain; Join `all` boleh menggantung selamanya — cancel jalan keluarnya.

Cancel: heartbeat ≤10 detik → SIGTERM ke process group → 30 detik → SIGKILL. **Cancel otoritatif di control plane**: baris langsung `cancelled` sehingga UI berubah seketika; balasan heartbeat hanya meminta Runner berhenti membakar CPU. Branch setengah jadi dibiarkan yatim untuk GC.

Rewind = **Run baru** dengan `parent_run_id`.

### Step yang menunggu manusia

**Agent mengakhiri run-nya tiap kali bertanya.** Tidak ada tool yang memblokir di dalam sandbox. `awaiting-human` adalah baris DB **tanpa lease**: Sandbox ditutup, Runner bebas, tahan-restart gratis, dan biaya infra nol.

Urutan satu giliran, dan hanya yang terakhir mengubah dunia:

```
push branch  →  unggah session ke blob  →  POST Question
```

Invarian: **Question ada ⇒ ref dan session pasti ada.** Mati sebelum POST → tidak ada Question, lease kedaluwarsa, sweep menjadwalkan ulang sebagai **attempt baru dari turn yang sama**.

Session diangkut lewat blob store (implementasi `AgentSessionStorage` sendiri dengan backend object storage), sehingga Runner interchangeable dan boleh di-drain selagi percakapan menggantung. Ini konsumen ketiga blob store setelah log dan Artifact.

Nama branch:

```
run/<run-id>/<step-key>/<branch-key>/t<turn>-a<attempt>
run/<run-id>/<step-key>/t<turn>-a<attempt>            # Step tanpa Key
```

Bentuk Question dan Answer, tertutup, skema Zod di `shared`:

```ts
type Question =
  | { kind: "text";     body: string }
  | { kind: "choice";   body: string;
      options: { id: string; label: string; description?: string }[];
      multi: boolean; allowOther: boolean }
  | { kind: "approval"; body: string }
  | { kind: "edit-artifact"; body: string; artifactKey: string }

type Answer =
  | { kind: "text";     value: string }
  | { kind: "choice";   ids: string[]; other?: string }
  | { kind: "approval"; approved: boolean; reason?: string }
  | { kind: "edit-artifact"; content: string }
```

**Penolakan adalah data**: `approved: false` dikirim balik ke agent sebagai prompt giliran berikutnya. Apa akibatnya ke Graph ditulis sebagai sifat Step (`onReject: fail | continue`), bukan tersirat di jawabannya.

Question ditujukan ke **Group** (audiens), bukan individu. Jawaban pertama menang lewat compare-and-set; penjawab selalu dicatat. **Tanpa kadaluarsa bawaan** — visibilitas menggantikan timer. Kalah balapan menjawab adalah **keadaan, bukan error**: `409` membawa state terbaru, klien menerapkannya, dan ketikan yang telanjur ditulis tidak dibuang.

Sunting draf dibatasi ke pemegang giliran menjawab; yang lain melihatnya read-only. Nol mekanisme penguncian kedua.

Cancel saat `awaiting-human` adalah **murni penulisan baris DB** — tidak ada lease, tidak ada Runner yang disentuh.

### Runner: siklus hidup dan penjadwalan

**Satu kolam Runner milik org.** Masuk kolam lewat **join token sekali pakai** yang ditukar jadi runner-id + secret di disk; identitas ada di file itu, bukan di hostname atau IP.

Kapabilitas: **fakta diprobe tiap start** (exec mode, agent CLI yang terpasang, cpu/ram), **kebijakan ditulis operator** (`slots`, label). Hash-nya ikut tiap heartbeat; control plane meminta laporan penuh saat hash berubah.

**Matching terbalik**: Runner datang membawa tag, control plane memilih StepRun. Kebutuhan sebagian besar tersirat dari Step dan dievaluasi sebagai containment tag **di dalam kueri klaim**, bukan oleh penjadwal terpisah. Slot ditegakkan Runner (penuh → berhenti poll) dengan klausa `count(*) < $slots` di kueri klaim sebagai pagar.

Kueri klaim: `FOR UPDATE SKIP LOCKED` + UPDATE bersyarat + cek baris terpengaruh, `ORDER BY ready_at` (FIFO murni, tanpa prioritas). Sweep dijalankan **sebelum listener dibuka** saat startup.

Dua window berbeda: heartbeat Runner tiap 10 detik dengan ambang online 30 detik; lease per-StepRun diperbarui tiap 10 detik dengan expire 30 detik.

Drain dan revoke lewat satu kolom `desired_state`, dibalas di heartbeat. **Revoke adalah fencing, bukan pembunuhan.**

Versi protokol integer, terpisah dari nomor rilis. Runner basi tetap terlihat di UI tapi tidak pernah dapat kerja.

Isolasi: `exec:docker` bawaan; host mode hanya lewat `runsOn: [exec:host]` yang disengaja. Di host mode, agent berjalan sebagai **user OS terpisah** dari proses Runner — tanpa itu agent tinggal membaca file secret dan naik jadi Runner. Secret tidak pernah **menetap** di disk Runner.

### Kontrak API control-plane ↔ Runner

**Sembilan endpoint POST, nol GET.** Runner tidak pernah menanyakan apa pun tentang dunia; semua yang ia butuh ikut di muatan `/claim` — ref, secret Project, token repo per-StepRun, snapshot definisi dan isi file prompt, dan presigned GET session untuk giliran lanjutan.

```
POST /join                       token sekali pakai → { runner_id, secret }
POST /claim                      long-poll 20–30s → StepRun + ref + secrets + lease_token
POST /heartbeat                  tiap 10s — satu-satunya kanal perintah
POST /runners/me/capabilities    laporan penuh saat caps_hash berubah
POST /runners/me/drain           CLI lokal menulis desired_state
POST /step-runs/:id/uploads      mint presigned PUT (artifact + session, satu batch per giliran)
POST /step-runs/:id/log-chunks   catat metadata chunk (batch)
POST /step-runs/:id/question      titik commit giliran bertanya
POST /step-runs/:id/result        titik commit giliran selesai/gagal
```

Pasangan invarian untuk giliran yang selesai — `push branch → unggah semua blob → POST result` — melahirkan: **StepRun `succeeded` ada ⇒ ref ada dan Output-nya sudah lolos gerbang otoritatif.** Metadata Artifact **menumpang request akhir itu**, supaya Output yang ditolak membuat seluruh giliran seolah tidak pernah terjadi. Harga yang dibayar sadar: artefak tidak muncul di UI sampai StepRun berakhir.

Otentikasi: `Authorization: Bearer` di atas TLS, server menyimpan SHA-256-nya, prefiks yang mengenali sumbernya. Aturan yang berlaku di kedua permukaan API: **tidak ada credential yang pernah muncul di path maupun query string.** HMAC ditolak: biaya penuh, manfaat separuh.

Versi protokol ikut tiap request, ditegakkan di dua tempat dengan dua cara: `/heartbeat` **selalu** diterima walau di luar rentang (balasannya memuat rentang yang didukung, dan UI menampilkan lencana), sementara `/claim` menjawab **426 Upgrade Required** — bukan respons kosong, karena Runner yang sehat-tapi-selamanya-menganggur tidak punya tempat untuk dilihat operator.

Semantik error, dan **hanya satu yang mematikan**:

| Status | Arti | Yang Runner lakukan |
|---|---|---|
| `401` | secret salah atau dicabut | **berhenti** |
| `426` | protokol di luar rentang | poll lambat 60s, heartbeat jalan terus |
| `409` | lease bukan milikmu lagi / StepRun sudah berakhir | lepaskan, lanjut `/claim` |
| `400` `422` | muatan ditolak, termasuk Output ditolak gerbang | fatal untuk giliran, bukan untuk Runner |
| `413` | melewati batas ukuran | fatal untuk request itu |
| `429` `503` | kelebihan beban / restart | backoff, patuhi `Retry-After` |
| `5xx` lain, timeout | tidak diketahui | backoff, ulangi |

Badan error `{ code, message }` — `code` untuk log dan UI, tapi Runner tidak pernah bercabang atasnya.

Muatan heartbeat:

```
POST /heartbeat  { leases: [{ step_run_id, lease_token }], caps_hash, free_slots }
→ { desired_state: "active" | "draining" | "revoked",
    cancel: [...], unknown_leases: [...], caps_stale: true,
    latest_release, protocol: { min, max } }
```

`unknown_leases` terpisah dari `cancel` dengan sengaja: dua sebab berbeda di satu daftar akan menghilangkan kemampuan operator membedakan "dibatalkan orang" dari "kamu kehilangan lease".

Idempotensi: **nol kunci baru**. Chunk log dijaga primary key-nya; Question dijaga id yang dibangkitkan klien; `/result` dijaga **`lease_token` itu sendiri** (sama → `200` dengan hasil yang sudah tercatat; berbeda → `409`, Runner ter-fence); `/uploads` **mengganti** grant sebelumnya alih-alih menambah, sehingga kuota diperiksa atas satu daftar utuh dan tidak pernah hanyut.

Long-poll: **durasi tahan diacak server di rentang 20–30 detik** sehingga herd sesudah restart pecah sendiri; backoff sisi Runner eksponensial dengan full jitter untuk kegagalan koneksi dan `5xx`. Implementasi tahan = poll kueri klaim tiap 1 detik per koneksi menggantung. Batas 2000 koneksi menggantung per instance, di atasnya `503` + `Retry-After`.

Batas ukuran: badan JSON 1 MiB semua endpoint; body Question 64 KiB (dipotong Runner dengan marker); batch log-chunks 256 entri; batch uploads 64 URL; timeout `/claim` klien 35 detik, endpoint lain server 10 detik.

Kendala deployment yang lahir dari sini: **reverse proxy wajib punya read timeout ≥60 detik.**

### Kontrak API web ↔ control plane

**REST + Zod → OpenAPI dibangkitkan**, sama dengan permukaan Runner. Nilai OpenAPI di sini adalah **klien Kotlin yang dibangkitkan** untuk aplikasi mobile menyusul, bukan pembaca manusia. tRPC gugur karena ia binding TypeScript, bukan protokol. Pilihan Hono vs Fastify jadi tidak berkonsekuensi.

Garis yang mengikat di seluruh sistem:

> Pemeriksaan izin **tidak boleh duduk di transport**. Fungsi domain menerima `Principal` sebagai argumen pertama, dan tabel hanya bisa dicapai lewat fungsi-fungsi itu. Transport adalah lapisan tipis yang memanggil.
>
> Ambient boleh untuk **otentikasi** (siapa kamu). Tidak pernah untuk **otorisasi** (boleh apa).

Sesi: cookie `httpOnly`, `Secure`, `SameSite=Lax`, baris sesi di Postgres. CSRF dibayar dengan `SameSite=Lax` + kewajiban header non-sederhana yang memicu preflight — nol token, nol tabel. Break-glass mendapat form password lokal yang menghasilkan cookie yang **sama persis**; yang membedakan hanya catatan audit. Bearer mobile menyusul sebagai satu cabang di verifikasi, nol tabel baru.

Kesegaran, tiga jalur:

```
Graph    → poll 3 detik + ETag (304 tanpa badan saat tidak bergerak)
Log      → long-poll ≤30s dari offset → daftar presigned GET
Lencana  → menumpang respons kedua-duanya, nol endpoint dan nol interval sendiri
```

SSE dan WebSocket ditolak atas alasan mereka sendiri, bukan atas alasan NAT: Runner flush chunk tiap 1 detik atau 256KiB, jadi data yang lebih segar memang tidak ada. 3 detik untuk Graph ditentukan oleh satu momen — menekan Cancel lalu menunggu layar mengakuinya.

Byte tidak pernah lewat control plane. Garage mendapat **hostname sendiri** (satu-origin dibatalkan oleh fakta bahwa SigV4 menandatangani path dan `Host`) dengan **CORS di bucket**: `GET` untuk browser, `PUT` untuk Runner. Presigned 5 menit **dinyatakan, tidak diperpendek**:

> Mencabut akses seseorang berlaku seketika untuk semua yang **akan** ia minta. URL presigned yang sudah terbit tetap valid sampai ≤5 menit. Pencabutan bukan penarikan kembali.

Penolakan izin: `401` belum login · `403` login tapi tidak boleh, badan menyebut project dan sebabnya · `404` benar-benar tidak ada. **403 mengalahkan 404** karena 404 mengubur jalan keluar yang sengaja dirancang untuk owner org. Yang bocor, dinyatakan telanjang: seseorang yang sudah memegang id resource bisa tahu resource itu ada.

Paginasi **keyset dengan `id` sebagai cursor** — jatuh gratis dari id yang terurut waktu. Offset ditolak: daftar yang di-poll 3 detik bergeser di bawah pembaca. **Tanpa total count.** Filter himpunan tertutup: *sedang berjalan* → `ended_at IS NULL`; *vonis akhir* → `outcome = …`.

Empat tombol tulis: Cancel Run (`member`), Rewind (`member`), pemicu manual (`member`), sakelar `automation_enabled` (`admin`). Cancel mengakui seketika sebagai **niat** (`cancel_requested_at`), bukan sebagai fakta. Idempotensi keempatnya nol kunci baru — id dibangkitkan klien, primary key menolak duplikat.

Editor Pipeline: **nama user tanpa credential user**. Git memisahkan author dari committer dan GitHub menghitung kontribusi dari author, jadi author = user penekan tombol lewat alamat `users.noreply.github.com`, committer = identitas bot, push dengan installation token ad-hoc yang dihapus setelah selesai. Commit dibuat lewat Git Data / Contents API, bukan clone lokal.

### Auth, tim, dan otorisasi

Login **GitHub OAuth**. Identitas GitHub hanya untuk **otentikasi**, tidak pernah untuk otorisasi. Zitadel dibatalkan: nilai jualnya tidak terpakai dengan IdP tunggal, dan sisanya adalah tabel Postgres plus sedikit kode. Satu akun **break-glass** lokal supaya pemadaman GitHub tidak mengunci kami keluar dari tombol cancel.

Peran: `admin` + `member` per Project, `owner` di level org. Peran `maintainer` ditolak — memisahkan "menulis Pipeline" dari "menjalankan Pipeline" tidak berarti untuk tim internal. **`owner` org tidak otomatis dapat akses data Project**; ia harus menambahkan dirinya jadi anggota, dan tindakan itu teraudit.

**Group** adalah himpunan bernama berisi anggota Project, dipakai untuk menyebut siapa yang diminta menjawab Question. Ia menjawab "siapa yang ditanya", bukan "siapa yang boleh apa". Anggotanya selalu anggota Project yang sama, jadi ia tidak pernah jadi jalur akses. Mengganti reviewer karenanya tidak menuntut PR.

`audit_log` **append-only ditegakkan lewat trigger di level DB**, bukan REVOKE — jaminan yang bergantung pada langkah operator adalah jaminan yang diam-diam bisa tidak ada. Sepuluh jenis kejadian. Nilai secret tidak pernah dicatat.

PAT dihapus (tidak punya satu pun konsumen).

### Credential, secret, dan akses repo

Kunci Project menempel ke **ServiceAccount**, bukan ke Project, sehingga invarian "credential hanya di Principal" terjaga secara struktural. Fallback User→ServiceAccount lewat `allowSharedAgentCredential`, **bawaan mati**. Biaya selalu diatribusikan ke Principal pemicu, dengan kolom terpisah untuk credential yang dipakai.

Git host adalah **GitHub**, dan `GitHost` tetap interface bertubuh sempit dengan satu implementasi. **GitHub App installation token wajib** — token di-mint **dua kali per giliran** (sebelum fetch dan sebelum push; umur 1 jam, tidak bisa refresh), dengan `repository_ids` sempit dan `contents:write` saja, lalu dihapus saat teardown. Ini muat karena Sandbox dilepas tiap giliran.

Enkripsi **AES-256-GCM dengan AAD = id secret + id Principal pemilik**, sehingga baris yang disalin ke Principal lain gagal didekripsi — invarian ditegakkan kriptografis, bukan oleh klausa `WHERE`. Master key dari **file, bukan environment variable**. `key_version` di tiap baris membuat rotasi **inkremental dan bisa diinterupsi**; rotasi tidak pernah mengganggu Run yang berjalan.

Env tidak pernah ditulis ke file di dalam sandbox — ia diserahkan langsung ke pemanggilan agent.

**Submodule dijawab dengan token kedua, bukan dengan pelebaran.** Izin sebuah installation token berlaku **seragam** atas seluruh `repository_ids`, jadi "satu token, `write` di repo utama dan `read` di repo submodule" tidak bisa ditulis. Maka repo submodule yang **dideklarasikan** mendapat token terpisah `contents:read`, dan repo utama tetap satu-satunya pemegang `contents:write` — aturan satu StepRun = satu repo bertahan harfiah di sisi tulis, dan repo submodule tidak pernah berada di daftar token yang memegang `write`. Control plane menolak deklarasi ke repo di luar Project, sehingga pelebaran yang bisa ditulis sendiri di sebuah branch tidak pernah melewati batas Project dan bukan eskalasi terhadap pemicunya.

Runner memasang config git untuk Sandbox lewat **`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`** — berorigin *command line* dan diwarisi seluruh pemanggilan turunan termasuk `git submodule update --recursive`, jadi nol byte kredensial menyentuh disk: `url.https://github.com/.insteadOf=git@github.com:` (universal, karena `.gitmodules` di lapangan merekam URL SSH), `credential.useHttpPath=true` dengan helper yang memilih token tulis untuk repo utama dan token baca untuk submodule, dan `protocol.ssh.allow=never` supaya submodule yang tidak dideklarasikan gagal seketika alih-alih menggantung menunggu kunci yang tidak pernah ada.

Menulis di working tree submodule tidak pernah dibatasi — yang dibatasi hanya push. Perubahan yang harus bertahan mengalir keluar sebagai **Output** ke StepRun ber-`repo:` repo itu, tidak pernah sebagai push kedua.

**Default-deny egress dari Sandbox** adalah kontrol utama; redaksi log **bukan** kontrol keamanan dan dinyatakan begitu. Yang menahan jalur eksfiltrasi lewat push adalah `repository_ids` sempit + **branch protection wajib**, dan factory **hanya membuka PR, tidak pernah merge**. Sandbox tidak pernah melewati `contents:write`; `pull_requests:write` milik control plane saja.

Enam hal yang sengaja tidak dilindungi ditulis eksplisit di dokumentasi keamanan. Yang keenam datang bersama submodule: isi repo submodule bisa disalin agent ke branch repo utama, dan yang menahannya bukan pencegahan melainkan **diff PR yang terbaca**.

### Artifact dan blob

**Artifact tidak punya kontrak.** Runner melapor bebas, Step tidak mendeklarasikan daftar artefak, dan **upload yang gagal permanen tidak menggagalkan StepRun**. Jaminan "step ini harus menghasilkan X" ditulis di skema **Output**, bukan di daftar artefak. Aturannya satu kalimat: *yang tidak dikonsumsi siapa pun boleh hilang; yang menggerakkan Graph tidak boleh masuk tanpa diperiksa.*

Artifact **immutable, satu per StepRun, tanpa tabel versi**. Suntingan manusia di giliran ke-7 adalah Artifact baru milik StepRun giliran ke-7, dan "riwayat PRD" adalah kueri per key diurutkan menurut turn. Stabilitas key lintas giliran hanya konvensi, dimitigasi normalisasi slug (di sini keunikan memang tidak pernah dijanjikan — berbeda dari Key fan-out).

**Diff dimaterialisasi jadi blob** saat StepRun berakhir, sehingga branch bebas dihapus.

Engine **Garage** (bukan MinIO — arsip upstream dan penerusnya berlisensi proprietary). Satu bucket, tiga prefix: artifact, log, session. **Semua ke blob, tanpa jalur inline Postgres** — ambang ukuran akan menggandakan jalur penghapusan. Presigned dua arah; **upload dulu → catat metadata**, invarian *baris Artifact ada ⇒ blob pasti ada*. Kuota 1 GiB per artefak dan 5 GiB per StepRun ditolak **saat URL diminta**, bukan setelah byte naik.

Pengecualian yang dinyatakan: **snapshot definisi inline di Postgres** (`runs.definition` dan `runs.definition_files`), karena ia bukan Artifact, jalur eksekusi membacanya, dan ia harus hidup persis selama baris Run.

Retensi digerakkan state Postgres, bukan lifecycle rule bucket: Artifact 90 hari sejak Run berakhir · Log 30 hari sejak Run berakhir · Branch saat Run berakhir **dan tidak ada PR terbuka yang bergantung padanya** · Session saat StepRun tak lagi `awaiting-human` **dan** Run berakhir. Ketergantungan itu dua bentuk: branch yang jadi **head** sebuah PR terbuka (menghapusnya menutup PR-nya), dan branch yang **ditunjuk pointer submodule** di head PR terbuka (menghapusnya menggantungkan pointer sebelum siapa pun sempat me-review). Ini satu-satunya predikat retensi yang tidak murni state Postgres — ia menanyakan keadaan PR ke GitHub. Pola penegakannya seragam: kolom penanda `*_purged_at` nullable pada baris pemiliknya dengan partial index, sehingga sweep jadi indexed scan yang **menyusut sambil bekerja** dan **idempoten**.

### Log

**Objek storage tidak bisa dibaca sambil ditulis**, jadi log yang belum selesai adalah **banyak objek**, bukan satu yang tumbuh. Kompaksi ditolak.

Runner flush tiap **1 detik atau 256 KiB**. Kunci **(StepRun, attempt)**; dedup di primary key `(step_run_id, attempt, seq)`, bukan di kode. Live-tail memakai bentuk long-poll yang sama dengan `/claim` dan mengembalikan **daftar presigned GET**, tidak pernah byte; arsip memakai endpoint yang sama dari offset nol.

Dua mekanisme berbeda yang tidak boleh tertukar: **ring buffer 64 MiB** membuang yang **tertua** (sebab kegagalan ada di ujung akhir), dan **batas 256 MiB memotong tanpa menggagalkan StepRun**. Di kawat keduanya tidak terlihat — masing-masing hanya menghasilkan satu chunk berisi marker. Control plane **tidak menghitung byte log sama sekali**; ia hanya mencatat ukuran yang dideklarasikan. Konsekuensinya dinyatakan: Runner yang bug bisa melewati batas dan control plane tidak akan tahu — diterima, karena Runner sudah ada di dalam batas kepercayaan.

Redaksi literal best-effort sebelum upload, **sama persis dengan redaksi Artifact, tidak lebih luas**. Regex "yang terlihat seperti kunci" ditolak: ia tidak memperbaiki jaminan, hanya membuat orang percaya ada jaminan.

### Step yang dieksekusi control plane

`kind: pull-request` adalah Step bawaan yang **tidak pernah diklaim Runner**. Ia lahir **sekali per cabang**, sehingga PR-per-repo jatuh gratis dan aturan satu-StepRun-satu-repo tidak dilonggarkan.

Eksekusinya **memakai ulang kueri lease** yang sama dengan Runner, dengan lessee berupa instance control plane, lease 60 detik tanpa heartbeat, dan sweep yang sudah ada memungut yang menggantung. Ini satu-satunya mekanisme yang menjawab "siapa yang mendeteksi control plane mati di tengah", dan biayanya nol kode baru.

Angka **milik jenisnya, bukan penulis** (`timeout: 60s`, `attempts: 3`, patuhi `Retry-After`); `timeout:`/`attempts:` ditolak skema pada Step ber-`kind:`.

Idempotensi bersandar penuh ke GitHub: cari PR yang cocok lalu adopsi, dan 422 diperlakukan sukses. Batasnya dinyatakan: PR yang sudah ditutup manusia menghasilkan PR baru, dan itu benar.

Rujukan `{ title, body }` **eksplisit** ke Step + nama Output, tidak pernah tersirat dari `after:`. `kind: pull-request` adalah **daun** — `after:` yang menunjuknya adalah error validasi.

Status ke commit lewat **Commit Status API** dengan `details_url` ke halaman Run. Checks API ditolak. **Permukaan tulis berhenti di dua izin**: nol komentar, nol label, nol tulisan ke issue.

### Automation

`on:` di file definisi, plus satu `automation_enabled` per Project sebagai **sakelar insiden**. Pendaftaran webhook jatuh gratis dari GitHub App: satu endpoint, satu secret, nol pemasangan per repo.

Pemetaan melayani dua himpunan: Pipeline bertuan-rumah repo X dibaca dari ref yang dipicu; Pipeline lintas repo di repo config dibaca dari default branch-nya. Inilah yang membuat **cache definisi wajib**, bukan optimasi — dengan **jalur pengisian sinkron saat miss**, karena tanpa itu "boleh dihapus kapan saja" adalah kebohongan. Cache tidak pernah dibaca jalur eksekusi; eksekusi membaca snapshot di baris Run.

**PR dari fork diabaikan seluruhnya** — satu baris menutup satu kelas serangan penuh, karena definisi dibaca dari head.

Dedup dua lapis: id delivery selama 24 jam, lalu kunci natural **(Pipeline, SHA)**. Yang kedua **harus partial unique index** yang berlaku hanya saat pemicunya automation dan bukan rewind — ditulis polos ia akan melarang rewind dan tombol pemicu manual.

Concurrency bawaan `cancel`, tetapi Pipeline ber-`ask:` **wajib menulis `concurrency:` eksplisit** (aturan bersyarat ditolak, validasi dipilih) supaya satu bawaan tidak mencabut seluruh mekanik human-in-the-loop dengan senyap.

Cron: skip saat tumpang tindih, dan pelewatannya terlihat. Jadwal baru hidup hanya setelah merge.

Branch dihapus atau PR ditutup ⇒ **cancel**, termasuk yang `awaiting-human`.

### Notifikasi

Yang memberi tahu adalah **state yang terbaca, bukan kejadian yang dikirim**. **Lencana adalah kueri, bukan tabel** — sehingga "batalnya notifikasi" lunas tanpa satu baris kode: dijawab orang lain atau Run dibatalkan ⇒ lencana padam serentak.

Dua kanal: in-app (lencana + halaman "Menunggu saya" diurutkan umur) dan **satu outgoing webhook per Project** dengan field teks — kolom di tabel Project, bukan tabel tersendiri. Email ditolak. Integrasi Slack ditolak demi webhook generik.

Notifikasi ke **channel, bukan orang**, jadi tidak ada kanal per-orang yang bisa membanjir. **Tanpa pengingat per-Question** dan **tanpa preferensi per-User**. Satu-satunya timer adalah digest harian per Project.

Kejadian: Question terbit + **Run gagal** (wajib, karena Automation berjalan sebagai ServiceAccount dan tidak punya manusia untuk diberi tahu). Fan-out 50 = satu pesan, lewat coalescing 60 detik di sweep yang sudah ada.

### Cost

Dua aturan yang membentuk semuanya: **yang tidak ada tidak diperkirakan; yang sudah ditulis tidak dihitung ulang.**

**Estimasi dilarang.** Agent tanpa laporan pemakaian menampilkan "tidak didukung", dan konsekuensinya diterima terang: total Project adalah **batas bawah, bukan total**, dan ditulis begitu di UI.

Biaya dihitung **sekali saat StepRun berakhir** dan disimpan bersama `price_version`; tidak ada tampilan yang mengalikan ulang. Tabel biaya **insert-only, satu baris per attempt**, sehingga retry tidak bisa menimpanya dan "kumulatif lintas attempt" jadi penjumlahan biasa alih-alih kolom yang berperilaku aneh.

Tiga agregasi saja, di endpoint terpisah yang tidak menumpang poll. Retensi: **tidak pernah kedaluwarsa**, seumur baris Run. `member` melihat semuanya termasuk per Principal.

**Tanpa kuota, dinyatakan telanjang**: satu Run liar bisa membakar kredit sampai habis dan sistem tidak akan menghentikannya. Yang dibangun sebagai gantinya adalah biaya berjalan yang tampil **selagi Run berjalan**, di layar yang sudah memuat tombol cancel.

### Skema database

**Drizzle** untuk skema, migrasi, dan seluruh CRUD. Batas dua gaya ditarik di muka: **hanya tiga hal ditulis SQL tangan** — trigger append-only, kueri klaim, dan sweep retensi. Ketiganya punya contract test.

Id: **UUIDv7 di-encode base32 dengan prefiks tipe**, satu identitas. Empat sifat dibayar sekaligus: terurut waktu (lokalitas indeks di daftar yang paling sering dibuka), aman sebagai komponen ref git (id disalin manusia ke `git checkout`), **bisa dibangkitkan klien** (idempotency key gratis, dan AAD enkripsi butuh id ada sebelum baris dienkripsi), dan prefiks membuat id menjelaskan dirinya saat muncul telanjang di log tiga komponen.

Kunci natural `step_runs`: **(run_id, step_key, branch_key, turn)** dengan `NULLS NOT DISTINCT`. `branch_key` NULL untuk Step non-fan-out — NULL berarti apa adanya: Step ini tidak punya Key. Sentinel string kosong ditolak. Constraint ini sekaligus yang menegakkan "Key duplikat menggagalkan Run" secara **struktural**.

Himpunan nilai tertutup memakai `text` + `CHECK`, bukan pgEnum — buktinya himpunan ini tumbuh sudah ada (kind Question dikunci tiga lalu jadi empat). Harganya dinyatakan: tipe yang berbeda tidak lagi mustahil tertukar di SQL mentah.

Tiga partial unique index yang benar-benar diperlukan: **satu Question terbuka per StepRun**; dedup **(Pipeline, SHA)** yang berlaku hanya untuk automation non-rewind; dan tabel dedup delivery webhook. Partial unique index `one_active_attempt_per_execution` dari prior art **tidak diperlukan** — ia melindungi model baris-per-attempt, sementara retry kita menimpa baris yang sama.

Tabel:

```
principals · users · service_accounts · org_members · projects · project_members
groups · group_members · repositories · secrets
github_app_installations · audit_log
runs · step_runs · step_run_costs · questions · artifacts · log_chunks
runners · runner_join_tokens
webhook_deliveries · pipeline_definition_cache
```

`principals(id, kind)` ada sebagai tabel sendiri dengan `users` dan `service_accounts` menunjuk padanya — itulah yang membuat "credential menempel ke Principal" jadi foreign key tunggal alih-alih sepasang kolom nullable yang saling meniadakan. **Tidak ada tabel `pipelines`.** Webhook notifikasi adalah kolom di `projects`.

Indeks daftar: `(project_id, id DESC)` untuk keyset; `(project_id, ended_at, id DESC)` untuk dua filter yang paling sering dipakai; partial index `questions (created_at) WHERE answered_at IS NULL` untuk "Menunggu saya".

### Packaging self-host

Docker Compose satu mesin. **Satu image untuk web + control plane**, yang menghapus skew web↔API secara struktural.

Migrasi adalah **servis one-shot** dengan dependensi `service_completed_successfully`, sehingga jumlah migrator adalah satu **secara konstruksi**; tetap memakai advisory lock untuk operator yang mengetik dengan tangan; plus **gerbang hash migrasi di boot** yang membuat "lupa migrasi" berisik alih-alih patah di endpoint pertama.

Garage di-pin eksak (versi di bawah ambang tertentu gagal di **upload pertama**, bukan saat boot) dan dijalankan dengan flag single-node yang menghapus seluruh langkah init manual.

Setup GitHub App lewat **manifest flow**: manifest kita yang menentukan izinnya, dan pertukarannya mengembalikan app id + private key + webhook secret sekaligus. Kelas "izin salah dicentang" lenyap, dan private key tidak pernah lewat clipboard.

Konfigurasi **dua tingkat**: bahan kunci (master key, private key GitHub App) ke **file**; password layanan (Postgres, webhook, Garage) ke **environment variable** — alasan `/proc/self/environ` dipersempit supaya jujur, karena agent tidak pernah berjalan di host control plane.

Migrasi **tidak** dituntut mundur-kompatibel ⇒ **upgrade adalah pemadaman**. Yang menyelamatkannya sudah ada: `awaiting-human` kebal karena tidak punya lease, dan pemadaman yang melampaui satu window lease didahului `drain`.

Backup: dump database + **sinkronisasi objek** (bukan salin direktori data), yang aman **khusus di sini** karena Artifact immutable dan objek log tidak pernah ditulis ulang. Master key di luar backup **ditegakkan lewat tata letak path**, bukan peringatan di dokumentasi.

Runner didistribusikan sebagai **tarball JS dengan prasyarat Node**, diputuskan oleh notarisasi Apple. Installer macOS adalah **skrip yang bisa dibaca**, dan **verifikasi isolasi jadi gerbang menuju identitas**: penukaran join token terjadi **setelah** terbukti bahwa user agent tidak bisa membaca file secret Runner. Instalasi separuh jadi karenanya menghasilkan mesin tanpa identitas yang tidak pernah dapat kerja.

DNS: satu hostname untuk web + API, satu lagi untuk blob store. Reverse proxy wajib punya read timeout ≥60 detik.

### Bahasa visual

Token dari design system yang sudah ada di organisasi (primary teal, skala neutral Primer, radius dan skala bayangan/tipografi dari Figma, light dan dark). Warna `--attention` dipersempit maknanya jadi **hanya** "ditulis manusia ke dalam artefak".

**Satu percabangan dari Corpus: separuh atas skala tipe.** `--fs-lg`, `--fs-xl`, dan `--fs-2xl` dinaikkan jadi `1.25 / 1.5 / 1.875rem`, sehingga langkahnya 1.25 · 1.20 · 1.25, bukan 1.13 · 1.11 · 1.20 seperti aslinya. Alasannya bukan estetika rasio: dari 75 pemakaian skala tipe di `packages/web/src`, **68 menumpuk di `--fs-xs` (52) dan `--fs-sm` (16)**, sementara empat langkah teratas dipakai tujuh kali di seluruh produk. Hierarki tinggal di langkah atas, jadi hanya langkah atas yang diperbaiki.

`--fs-xs` dan `--fs-sm` **dibekukan pada nilai Corpus** dan tidak boleh ikut direnggangkan. Keduanya memikul seluruh permukaan operasional yang padat — tabel Run, baris meta, chip, log — yang justru hidup dari kepadatan itu. Konsekuensinya langkah bawah tetap rapat (1.17 dan 1.14), dan detektor desain akan terus menandainya sebagai "flat type hierarchy". Itu keputusan, bukan sisa pekerjaan.

Tidak ditambahkan: langkah di bawah `--fs-xs` dan di atas `--fs-2xl`. Keduanya diminta prototipe beranda (`docs/design/distributed-software-factory/prototypes/home-ui`), tapi belum punya pembaca di kode. Tambahkan bersama kode yang membacanya, jangan mendahului.

Aturan tampilan yang ikut terkunci dari prototype: kotak fan-out **meringkas di atas delapan cabang** dengan urutan `failed` → `awaiting` → `unsched` → `running`; panel kanan tetap sehingga **tidak ada URL per StepRun**; status berbentuk, bukan sekadar titik berwarna; notasi giliran **ditulis panjang** (`giliran 4 · attempt 1`) di mana-mana kecuali di nama branch, di mana ia literal dan disalin ke `git checkout`; layar grilling **berdampingan** (percakapan + draf) di desktop, bertumpuk hanya di layar sempit; kotak teks **tidak pernah hilang** walau ada pilihan; **tanpa tombol "Selesai"** di layar grilling.

### Beranda

Hari ini `/` adalah fallback tanpa gaya. Bentuknya diputuskan lewat tiga belas ronde grilling di `prototypes/home-ui/index.html`; alasan tiap keputusan ada di kepala file itu, yang di bawah adalah apa yang dibangun.

**Bentuk keseluruhan.** Tiga zona tetap: nav rail kiri, pusat kerja, rail kanan. Bukan inbox satu kolom, bukan tabel Run, bukan linimasa, bukan kartu per Project.

**Pusat ikut keadaan.** Ada Question menunggu ⇒ pusat **adalah** pertanyaan itu. Tidak ada ⇒ pusat kembali jadi Graph. Graph tidak boleh hilang dalam keadaan mana pun: pertanyaannya muncul sebagai **sheet yang bersandar** ke node `awaiting-human` lewat tali putus-putus, di dalam ruang koordinat Graph, dan **mengikuti** saat kanvas digeser — talinya digambar ulang tiap scroll sehingga ikatannya ke node tidak pernah putus.

**Kendali jawaban menyebut akibatnya**, bukan hanya namanya: "Setujui → `pecah-tugas` jalan, fan-out implementasi lahir 3 cabang". Salah jawab di sini melahirkan fan-out, membuka PR, atau membatalkan Run. Untuk `edit-artifact`, perubahan giliran ini **dibaca sebagai diff dulu** (baris agent, baris manusia, baris dibuang), baru disunting.

**Rail kanan** memuat Run, runner pool, dan biaya. Ia tetap ada dan tetap penuh isi dalam keadaan apa pun — pemantauan ambient berhak atas ruangnya walau sebagian besar waktu tidak menuntut tindakan. Ditolak: rail yang kosong saat sehat, rail yang dihapus, dan urutan panel yang bergeser mengikuti keadaan.

**Pita alarm** menempel di kepala rail dan **menambah, tidak pernah menggantikan**; ketiga panel tetap utuh di bawahnya. Satu alarm satu baris ringkas; semua alarm terlihat setiap saat, tidak ada yang dipotong atau disembunyikan di balik "+n lagi". Baris bisa **ditekan dan terbuka di tempat**, tanpa keluar dari rail. Alarm **dikelompokkan per jenis, isinya per kejadian**: kepala menyebut jumlah ("4 Run gagal"), isinya menyebut yang mana lengkap dengan attempt-nya. Pengelompokan adalah kompresi, bukan pembuangan — karenanya jumlah baris pita stabil terhadap beban, dan pita tidak perlu batas tinggi buatan.

**Hari pertama, beranda adalah daftar penyiapan.** Selama belum ada Run, seluruh permukaan berganti jadi empat langkah berurut: daftarkan Runner → buat Project → tulis Pipeline → jalankan Run. Ini konsekuensi dari aturan "pusat ikut keadaan", bukan pengecualian terhadapnya.

Daftar itu **diturunkan dari keadaan, bukan disimpan**. Sebuah langkah selesai karena datanya ada — ada Runner hidup, ada Project, ada Pipeline, ada Run — bukan karena sebuah flag dicentang. Konsekuensinya mengikat: **tidak ada kolom `onboarding_completed`, tidak ada migrasi, tidak ada tombol lewati, tidak ada "tampilkan lagi nanti", tidak ada tur.** Semuanya menuntut state tersimpan, dan tidak satu pun dibutuhkan kalau daftarnya turunan. Daftar itu hilang sendiri begitu Run pertama ada, dan kembali sendiri kalau prasyaratnya hilang.

`--fs-2xs` dan `--fs-3xl` yang ditangguhkan di atas masuk bersama layar ini — beranda adalah pembaca yang ditunggu.

## Testing Decisions

Apa yang membuat test bagus di repo ini: **ia menembak perilaku yang terlihat dari luar sebuah seam, dan tidak pernah menyentuh apa yang ada di dalamnya.** Test yang menegaskan bentuk internal — nama fungsi, urutan pemanggilan, isi tabel yang tidak pernah dibaca API — mengunci refactor dan akan dihapus saat ditemukan. Setiap test harus deterministik: jam, jaringan, dan seed acak diinjeksikan, tidak pernah dibaca dari lingkungan.

**Tiga seam. Satu utama, dua palsu.** Jumlahnya sengaja sedikit dan ketiganya sudah dinamai keputusan desain sebelum spec ini ada — bukan seam baru yang dibuat demi test.

**Seam 1 — REST API control plane (utama).** Test menembak HTTP di atas **Postgres sungguhan** (kontainer sekali pakai, migrasi dijalankan apa adanya). Runner dipalsukan sebagai **HTTP client biasa** yang bicara sembilan endpoint kontrak, bukan sebagai objek yang di-mock. Ini seam tertinggi yang tersedia dan hampir seluruh perilaku sistem bisa dinyatakan lewatnya:

- materialisasi Graph hibrida, fan-out dinamis dari Output, Key duplikat menggagalkan Run
- kebijakan Join `all`/`any`/`min: N`, dan Run `succeeded` walau ada StepRun `failed`
- kueri klaim: containment tag, batas slot, FIFO, `SKIP LOCKED` di bawah klaim serentak
- lease kedaluwarsa → sweep → penjadwalan ulang sebagai attempt baru, dan `unknown_leases` di heartbeat
- siklus penuh step interaktif: Question terbit → `awaiting-human` tanpa lease → jawaban → giliran berikutnya diklaim Runner **lain**
- compare-and-set jawaban Question, dan `409` yang membawa state terbaru
- idempotensi keempat request tulis, termasuk `lease_token` sebagai kunci `/result`
- `426` untuk protokol di luar rentang di `/claim`, dan `/heartbeat` yang tetap menerimanya
- otorisasi: `Principal` sebagai argumen eksplisit, `403` vs `404`, dan owner org yang ditolak
- Output ditolak gerbang otoritatif → `failed` dengan `reason: output-invalid`, memakan attempt
- cancel: baris jadi `cancelled` seketika, `/result` yang telanjur dikirim dijawab `409`
- retensi: keempat sweep, dan idempotensinya saat dijalankan dua kali

**Seam 2 — agent-runtime (palsu).** Direktori yang sudah dikunci sebagai satu-satunya importir sandcastle, mengekspor `startTurn(spec) → { done, cancel() }`. Test Runner memasang implementasi palsu yang memancarkan tag Output yang sudah ditentukan, sehingga **tidak ada LLM sungguhan yang pernah dipanggil** dan skenario "agent memancarkan Output tidak valid" bisa ditulis sebagai satu baris. Yang diuji lewat seam ini: pembangkitan blok instruksi dari `outputs:`, urutan commit satu giliran (push → upload → POST), ring buffer dan pemotongan log, dan penurunan `maxRetries` dari kapabilitas agent.

Terpisah dari itu dan tidak boleh tertukar: **contract test terhadap sandcastle sungguhan** atas tiga perilaku internal yang bukan kontrak publik dan patah senyap — gerbang session capture, path worktree verbatim, dan idle timer yang di-reset tiap output. Test ini menjawab *apakah upgrade aman*, dan ia satu-satunya yang memanggil sandcastle asli.

**Seam 3 — GitHost (palsu).** Interface bertubuh sempit dengan satu implementasi sungguhan. Test memasang implementasi palsu untuk menyatakan: PR dibuka sekali per cabang, adopsi PR yang sudah ada, 422 diperlakukan sukses, Commit Status ditempel dengan `details_url`, minting dan penghapusan token dua kali per giliran, dan PR dari fork diabaikan.

**Yang diuji di luar ketiganya, karena memang tidak punya rumah di sana:**

- **Validator definisi Pipeline** — fungsi murni dari teks YAML ke hasil validasi. Setiap klausa XOR dan setiap aturan lintas-bidang mendapat satu kasus valid dan satu kasus ditolak, dengan file prototype yang sudah ada dipakai sebagai fixture yang harus tetap lolos.
- **Tiga SQL tangan** (trigger append-only, kueri klaim, sweep retensi) — contract test langsung ke Postgres, karena Drizzle tidak menjaminnya dan ketiganya adalah jalur terpanas sistem.
- **OpenAPI yang dibangkitkan** — dijaga CI: dokumen hasil generator harus identik dengan yang tersimpan di repo, kalau tidak CI merah.
- **Web** — test komponen untuk layar grilling dan panel graph, dengan API dipalsukan di lapisan HTTP. Bukan test end-to-end browser; itu belum dibayar.

**Prior art**: belum ada — repo ini nol commit. Konvensi yang dipilih di sini adalah prior art untuk yang berikutnya, jadi seam pertama yang ditulis sebaiknya ditulis dengan asumsi akan disalin.

## Out of Scope

Ditutup permanen — menariknya kembali adalah proyek baru, bukan lanjutan:

- **SaaS multi-tenant dan billing.** Pengguna dipatok tim internal satu organisasi.
- **Tahapan SDLC sebagai entitas kelas satu** (Requirement, Design, Ticket, Review dengan skema, layar, dan aturan transisi sendiri). Manajemen pekerjaan diserahkan ke GitHub; factory berhenti pada "apa yang sedang dan sudah dijalankan". Tidak ada keputusan model data di sini yang menyiapkan jalannya.
- **Pencarian log lintas Run.** Log sudah jadi objek dengan prefix yang bisa ditebak, jadi pengindeks eksternal bisa dipasang belakangan tanpa perubahan di sini.
- **Kubernetes, high availability, dan TLS di dalam compose.** Dua instance control plane berjalan **benar secara mekanis** karena lease sudah menanganinya, tapi tanpa load balancer, dokumentasi, atau uji — "tidak didukung", bukan "tidak mungkin", dan bedanya dinyatakan supaya tidak ada yang membangun di atasnya diam-diam.
- **Aplikasi mobile Compose Multiplatform.** Premisnya sudah dibayar (REST + OpenAPI, bearer sebagai satu cabang aditif), tapi membangun aplikasinya adalah destination baru.
- **Auto-provisioning worker di cloud.** Runner didaftarkan manual oleh operator.
- **Ambang tahan-sandbox untuk step interaktif.** Tidak ada prototype yang bisa menghasilkan angkanya; ia hanya terukur di Runner sungguhan.

Aditif dan sengaja tidak dibangun sekarang, masing-masing sudah punya bentuk yang dirumuskan supaya tidak perlu dipikirkan dari nol:

- **Fan-out bersarang** (menuntut Key jadi tupel, branch dua tingkat, dan Join menyatakan tingkat mana yang ia gabungkan)
- **`uses:`** untuk blok definisi yang dipakai ulang
- **Prioritas dan keadilan** di kolam bersama (satu klausa `ORDER BY` lagi)
- **Run berparameter (`inputs:`)**
- **`outputs:` untuk Step `run:`** (dan karenanya fan-out dari keluaran perintah shell)
- **Bacaan lintas repo tanpa tautan submodule** — submodule yang dideklarasikan sudah punya jalur baca (token kedua `contents:read`), tapi sebuah Step yang ingin membaca repo lain semata karena ia ingin, atau yang butuh source dua repo hidup bersamaan untuk integration test, masih tidak bisa ditulis; verifikasi lintas repo terjadi setelah PR terbuka
- **Trigger Run dari komentar GitHub**
- **Kuota biaya dan rem otomatis**
- **Notifikasi untuk Runner offline**
- **Push notification mobile**
- **Upgrade tanpa pemadaman**
- **`LISTEN/NOTIFY`** untuk long-poll `/claim` (aditif murni; aturan "ukur sebelum optimasi" menahannya)
- **Penegakan egress di Runner `exec:host`** — belum diputuskan apakah wajib atau opsional per operator
- **VM macOS sebagai jalan keluar isolasi** — laten dan murah (satu file provider), dibuka lagi kalau isolasi antar-Project di mesin macOS berubah dari nyaman jadi wajib

## Further Notes

**Tiga wilayah tanpa cetak biru.** Sistem ini melakukan tiga hal yang tidak ada prior art-nya, dan ketiganya sudah diperiksa sampai tahu bahwa memang tidak ada:

1. **Git sebagai bus antar step.** Argo mendukung git sebagai input artifact tapi **eksplisit menolaknya sebagai output**. Sandcastle bekerja sepenuhnya lokal dan tidak pernah push ke remote — transportnya kita bangun sendiri sebagai wrapper.
2. **Scoping credential per Principal di CI.** Tidak satu pun dari lima sistem CI yang dipelajari melakukannya.
3. **Prompt injection sebagai kelas ancaman.** Kelima sistem itu hanya mengantisipasi "penyerang menulis pipeline.yml", bukan "agent dibujuk lewat konten yang ia baca". Ada CVE nyata di kelas ini.

**Delapan belas keputusan diambil agent sendirian dan belum pernah dibantah siapa pun** — tersebar di skema DB (enam terakhir: biaya, secret, retensi, dedup, cache definisi, snapshot definisi), seluruh kontrak API Runner, empat sub-pertanyaan kontrak API web, dan enam sub-pertanyaan packaging. Semuanya konsekuensi dari keputusan yang sudah dikunci ticket lain dan tidak satu pun membuka arah baru, tapi tidak satu pun juga sudah melewati orang kedua. Baca sebagai **rekomendasi kuat, bukan keputusan yang sudah diadu** — dan kalau implementasi menemukan salah satunya salah, itu bukan penyimpangan dari spec.

**Satu klaim sudah diverifikasi dan ternyata salah** (probe issue #20/#42, dijalankan 2026-08-12): commit yang dibuat lewat GitHub API dengan installation token **tidak** ditandatangani GitHub selama request menyebut `author` atau `committer`. GitHub hanya menandatangani commit API yang tidak menyebut identitas sama sekali — commit itu lalu ditulis atas nama bot App dengan committer `GitHub <noreply@github.com>`. Karena atribusi ke user penekan tombol adalah inti issue #20, editor menyebut identitas dan commit-nya unsigned. Lihat `docs/adr/0004-pipeline-editor.md`.

**Satu keputusan masih terbuka.** Layanan pendukung di dalam Sandbox — Step yang butuh database, cache, atau antrean untuk menjalankan pekerjaannya (pembangkitan dump skema, integration test) belum punya jalur, dan default-deny egress menutup jalan ke layanan di luar. Lihat [ticket 30](https://github.com/adryanev/factory/issues/113). Ia tidak mengubah satu pun bentuk yang dikunci di sini, tapi rantai submodule tidak lengkap tanpanya.

**Urutan yang disarankan.** Spec ini adalah seluruh sistem, dan seluruh sistem bukan satu unit kerja. Irisan vertikal pertama yang membuktikan arsitekturnya: trigger → materialisasi Graph → `/claim` → agent berjalan → push branch → Output lolos gerbang → `kind: pull-request` membuka PR, dengan fan-out dan Join ikut sejak awal karena keduanya membentuk skema dan kontrak. Human-in-the-loop menyusul sebagai irisan kedua — ia tidak mengubah satu pun bentuk yang dikunci di irisan pertama, ia menambahkan state tanpa lease.

**Bahasa.** Spec dan diskusi dalam Bahasa Indonesia; istilah domain (Pipeline, Step, Run, StepRun, Output, Ref, Runner, Principal, Question) tetap dalam bahasa Inggris sesuai glossary di `CONTEXT.md`, dan kata-kata yang ditandai `_Avoid_` di sana tidak dipakai.
