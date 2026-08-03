# Di mana definisi pipeline hidup

Type: grilling
Status: resolved
Blocked by: 05

## Question

Definisi pipeline itu file YAML di dalam repo, baris di database yang disunting lewat UI, atau keduanya — dan kalau keduanya, siapa yang menang?

Arah editor visual sudah dipatok: **visual → code**. Editor menghasilkan definisi berbentuk kode, bukan baris database buram. Itu menutup pilihan "DB saja". Yang tersisa: kode itu tinggal di mana, dan siapa yang menang kalau ada dua salinan.

1. **Sumber kebenaran** — pilih salah satu dari tiga:
   - *Repo saja*: YAML di-commit bersama kode, UI hanya membaca. Definisi selalu cocok dengan commit yang dijalankan, ter-review lewat PR, tersedia offline. Editor visual jadi generator YAML yang membuka PR, bukan penyunting langsung.
   - *DB saja*: definisi disimpan di control plane, repo tidak tahu apa-apa. Masih bisa berbentuk kode, tapi terlepas dari kode yang dijalankannya, dan tidak lewat review.
   - *Keduanya*: butuh aturan presedensi eksplisit dan cerita sinkronisasi. Paling mahal.
2. **Skema definisi** — bentuk file: bagaimana step, dependensi, fan-out, agent, prompt, dan kebutuhan worker ditulis. Bagaimana ia divalidasi dan kapan (saat commit, saat trigger, atau saat menyimpan di UI).
3. **Referensi prompt** — sandcastle mendukung prompt inline, template berbasis file, dan konteks dinamis lewat `` !`command` ``. Prompt hidup di repo bersama kode, atau di definisi pipeline? Kalau di repo, editor visual tidak bisa menyuntingnya.
4. **Versioning** — ketika definisi berubah, apa yang terjadi pada run yang sedang berjalan. Bagaimana run lama tetap bisa dibaca. Ini menyambung ke keputusan snapshot-versus-referensi di ticket 05.
5. **Peran editor visual** — setelah sumber kebenaran dipilih, apa sebenarnya yang editor lakukan. Kalau jawabannya "membuka PR berisi YAML", katakan itu sekarang supaya scope UI tidak melar diam-diam.
6. **Batas kemampuan** — apakah definisi boleh berisi ekspresi/kondisi, atau sengaja dibuat tidak bisa dihitung (non-Turing). Yang kedua jauh lebih mudah divisualkan dan dijelaskan.

Rekomendasi awal untuk diuji: repo sebagai sumber kebenaran, editor visual sebagai penyusun yang menghasilkan PR.

**Diwarisi dari ticket 14** — sebuah Step interaktif membawa empat bidang deklaratif yang skema definisi wajib tampung, karena ticket 14 memutuskan bahwa alur ditulis di definisi Pipeline, bukan tersirat di dalam jawaban manusia:

```yaml
step review:
  ask: role("reviewer")     # bawaan: trigger()
  onReject: fail            # bawaan: continue
  humanTimeout: none        # bawaan
  onHumanTimeout: fail      # hanya bermakna kalau humanTimeout diset
```

Dua hal yang ini bebani ke pertanyaan di atas: sub-pertanyaan 6 (**batas kemampuan**) harus memutuskan apakah `ask:` boleh berisi ekspresi yang dihitung saat runtime atau hanya konstanta — `role("reviewer")` sudah terlihat seperti pemanggilan fungsi. Dan sub-pertanyaan 5 (**peran editor visual**) sekarang punya kasus uji tajam: gerbang persetujuan adalah hal yang paling wajar disunting non-programmer, tapi kalau sumber kebenarannya repo, mengubah reviewer berarti membuka PR.

## Answer

Rekomendasi awal ticket ini bertahan utuh: **repo sebagai sumber kebenaran, editor visual sebagai penyusun yang menghasilkan PR**. Yang tidak diantisipasi ticket ini adalah premis yang dibawa masuk saat ditanya repo mana yang memegang file: **satu Project itu frontend, backend, etl, infra, mcp, dan crawler.** Multi-repo bukan kasus pinggiran di sini, ia kasus normal — dan itu yang membentuk lebih dari separuh keputusan di bawah.

### Sumber kebenaran: repo, dan definisi ikut ref yang dipicu

File definisi di-commit ke repo, UI hanya membaca. Tidak ada jalur "simpan langsung dari editor", tidak ada presedensi untuk diperdebatkan, tidak ada cerita sinkronisasi dua arah.

Saat Run dipicu, definisi dibaca dari **ref yang dipicu**, bukan dari default branch. Konsekuensinya yang paling berharga: perubahan pipeline ikut di-review bersama kode yang diubahnya, dan **bisa diuji sebelum di-merge** cukup dengan menjalankan branch PR-nya. Ini menutup sub-pertanyaan "mode draft di editor" tanpa membangun apa pun — jalur ujinya sudah gratis dari keputusan ref.

Editor visual, karenanya, adalah **generator PR** dan bukan penyunting sistem berjalan: susun di kanvas → tombol → PR berisi file YAML di repo tuan rumah. Scope UI terkunci di sini dan tidak melar diam-diam. Ini menjawab sub-pertanyaan 5 persis seperti yang ticket ini minta dinyatakan sekarang.

### Repo Tuan Rumah: satu aturan yang melayani dua pemakaian

Tiap Pipeline punya **satu Repo Tuan Rumah**, dan definisinya selalu dibaca dari ref repo itu. Tidak ada aturan kedua.

- Pipeline yang cuma menyentuh backend bertuan rumah di repo backend. Properti "ter-review bersama kodenya" utuh.
- Pipeline lintas repo bertuan rumah di **repo config Project** — sebuah `Repository` biasa yang diberi penanda, bukan entitas baru. Izin, token, dan webhook-nya persis sama seperti repo lain, jadi tidak ada jalur akses kedua yang harus diamankan terpisah.

Yang sengaja tidak dilakukan: memaksa semua definisi ke repo config (menghapus alasan utama memilih "repo saja"), dan memaksa pipeline lintas repo memilih salah satu repo kode sebagai tuan rumah (sembarang, dan orang tidak akan menemukan file-nya).

Kode tiap repo diambil dari **default branch masing-masing, boleh ditimpa saat trigger**. Definisi tidak menuliskan nama branch untuk kasus biasa, jadi tidak ada nama branch basi yang menunggu untuk membusuk di file.

### Satu StepRun menyentuh satu repo — ini yang menyelamatkan ticket 06

Ini keputusan paling berkonsekuensi di ticket ini. Alternatifnya — satu StepRun boleh banyak repo, Output jadi peta `repo → Ref` — membongkar tiga hal yang sudah dikunci sekaligus: bentuk Output di ticket 05 (*"satu Ref"*), penamaan Branch di ticket 14, dan mekanik Join satu-repo di ticket 06.

Dengan satu repo per StepRun, ketiganya tidak disentuh sama sekali. Kerja lintas repo dikerjakan lewat mesin yang **sudah ada**: fan-out ber-Key nama repo.

```
plan → { frontend, backend } → join
```

`over:` bersumber konstanta (ticket 06 mengizinkan itu), dan Key-nya adalah nama repo — persis definisi Key di `CONTEXT.md`: penanda bermakna yang terbaca manusia, muncul di nama Branch, log, dan UI. Tidak ada konsep baru yang lahir.

**Harganya dibayar di muka dan harus dinyatakan**: satu Agent tidak bisa mengubah frontend dan backend dalam satu giliran. Perubahan yang menyentuh kontrak API antar repo **wajib** memutuskan kontraknya di Step sebelum fan-out, lalu tiap cabang mengimplementasikannya. Ini membatasi cara kerja, tapi arahnya sejalan dengan destination: yang di depan fan-out itu persis tempat PRD dan desain kontrak hidup.

**Lubang yang ditemukan dan tidak ditutup di sini**: ticket 06 menulis Join sebagai *"fetch ketiga branch ke satu repo"*. Untuk fan-out ber-Key nama repo, cabang-cabangnya ada di repo yang berbeda, jadi Join tidak bisa mengambil kodenya — ia hanya bisa membaca manifest. Dinaikkan jadi ticket sendiri (`21`), karena jawabannya menyangkut apakah Join butuh kelas "step tanpa repo", bagaimana ia membuka PR di banyak repo, dan apakah PR-PR itu harus di-merge bersamaan.

### Definisi adalah data murni: YAML, tanpa ekspresi, tanpa hitungan

Tidak ada bahasa ekspresi. Semua nilai adalah konstanta atau rujukan langsung ke Output Step lain. Tidak ada `if`, tidak ada pemanggilan fungsi, tidak ada interpolasi yang dievaluasi.

Ini menutup sub-pertanyaan 6 dan langsung **mengoreksi satu bentuk yang ditulis ticket 14**: `ask: role("reviewer")` terlihat seperti pemanggilan fungsi, dan kalau dibiarkan ia menjadi ekspresi pertama yang membuka pintu untuk semua ekspresi berikutnya. Bentuk yang berlaku adalah data:

```yaml
ask:
  group: reviewer
```

Formatnya **YAML**, satu file satu Pipeline, dengan `version: 1` sejak file pertama. TypeScript ditolak bukan karena tipenya tidak berguna, tapi karena menjalankan file TS milik user di control plane berarti mengeksekusi kode asing di komponen paling tepercaya — dan itu membatalkan "tanpa ekspresi" di kalimat yang sama. Validasi tetap dapat tipe: skema Zod di paket `shared`, dipakai control plane, editor, dan PR check dari satu definisi yang sama.

Satu file satu Pipeline dipilih supaya cocok dengan identitas berbasis path (di bawah), dan supaya menghapus Pipeline sama dengan menghapus file.

### Grup: audiens yang bisa diubah tanpa PR

Kasus uji tersulit yang ticket ini ajukan sendiri — *"mengubah reviewer berarti membuka PR"* — diselesaikan dengan memisahkan **nama** dari **keanggotaan**. Definisi menyebut nama grup; siapa anggotanya ada di DB dan disunting lewat UI. Mengganti reviewer tidak menyentuh repo sama sekali, dan definisi tetap stabil melewati pergantian orang.

**Grup sengaja terpisah dari peran otorisasi ticket 11.** `admin`/`member`/`owner` menjawab "siapa boleh apa"; Grup menjawab "siapa yang diminta menjawab". Menyatukannya berarti `ask: { role: member }` — terlalu luas untuk gerbang review — atau menambah peran otorisasi baru setiap kali tim butuh audiens baru.

Konsekuensi yang diputuskan di sini, bukan ditunda: **anggota Grup wajib anggota Project yang sama.** Grup adalah himpunan bagian, bukan jalur akses kedua. Menambahkan orang luar ke grup tidak memberinya akses, jadi tidak ada cara memakai grup untuk menembus batas isolasi Project yang dikunci ticket 05.

### Validasi yang mengikat ada di control plane, saat trigger

Ini satu-satunya gerbang yang tidak bisa dilewati siapa pun. Definisi rusak = Run ditolak sebelum satu Runner pun dipakai.

PR check dan validasi live di editor tetap dibangun, tapi statusnya **umpan balik awal, bukan penentu** — keduanya bisa dilewati (file disunting tangan, branch belum pernah lewat PR), sementara trigger tidak bisa. Ketiganya memakai skema Zod yang sama, jadi ini satu validator di tiga tempat, bukan tiga aturan.

### Snapshot: definisi + isi file prompt + SHA

Prompt boleh inline maupun file terpisah — sandcastle mendukung `prompt` dan `promptFile` tanpa file config apa pun (`research/sandcastle-api.md:73`), jadi mendukung keduanya berbiaya nol dan memang keduanya berguna: pendek inline, panjang jadi `.md` yang bisa di-review dan dipakai ulang.

Karena prompt boleh tinggal di file lain, menyimpan definisi saja **tidak cukup** untuk memenuhi janji ticket 05 bahwa Run tetap terbaca "meskipun definisi aslinya berubah atau hilang". Jadi Run menyimpan: teks definisi, **isi semua file prompt yang dirujuk**, dan SHA commit tuan rumahnya. Semuanya teks, jadi harganya nyaris nol, dan Run lama tidak lagi bergantung pada GitHub masih menyimpan branch itu.

### Identitas Pipeline: repo tuan rumah + path file

Tidak ada id, tidak ada pendaftaran. Dua file di dua commit adalah Pipeline yang sama kalau path-nya sama di repo yang sama.

Yang dibayar: memindahkan atau mengganti nama file = Pipeline baru, dan riwayat Run lama terputus. Ini diterima sadar. Alternatifnya (`id` di dalam file) menuntut penegakan keunikan lintas repo yang saling tidak tahu satu sama lain — mekanisme yang jauh lebih mahal daripada masalah yang dipecahkannya untuk tim internal.

### Cache definisi adalah turunan murni

Control plane menyimpan tabel cache definisi, diperbarui saat ada push, **hanya** untuk daftar dan pencarian di UI. Eksekusi tidak pernah membacanya — eksekusi selalu mengambil file dari ref yang dipicu.

Aturan yang membuat ini bukan sumber kebenaran kedua: **cache boleh dihapus seluruhnya kapan saja dan dibangun ulang dari repo.** Kalau suatu saat ada jalur eksekusi yang membaca cache, aturan itu sudah dilanggar dan Run bisa jalan dengan definisi yang tidak ada di commit mana pun.

### Yang sengaja belum dibangun

- **`uses:` / Step yang dipakai ulang lintas file.** Diakui bahwa 6 repo dengan pipeline test yang mirip akan terduplikasi. Ditunda karena menambahkannya bersifat aditif murni: satu field baru, satu langkah resolusi sebelum validasi, dan mesin snapshot isi file sudah dibangun untuk prompt. Tidak ada keputusan di atas yang perlu ditinjau ulang saat nanti ditambahkan.
- **Mode draft di editor.** Tidak dibangun karena jalur ujinya sudah ada gratis: jalankan branch PR-nya.
