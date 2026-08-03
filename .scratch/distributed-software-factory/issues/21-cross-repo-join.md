# Join lintas repo: menggabungkan cabang yang tinggal di repo berbeda

Type: grilling
Status: resolved
Blocked by: 06, 08

## Question

Sebuah Step Join menggabungkan cabang-cabang yang berasal dari repo yang berbeda. Ia bekerja bagaimana, kalau satu StepRun hanya boleh menyentuh satu repo?

Ticket 08 mengunci **satu StepRun = satu repo**, dan menjadikan fan-out ber-Key nama repo (`plan → {frontend, backend} → join`) sebagai satu-satunya jalur kerja lintas repo. Itu menyelamatkan bentuk Output ticket 05, penamaan Branch ticket 14, dan mekanik Join ticket 06 dari pembongkaran — tapi meninggalkan lubang tepat di ujungnya.

Ticket 06 menulis Join sebagai *"fetch ketiga branch ke satu repo"*. Itu jalan ketika ketiga cabang berasal dari repo yang sama. Ketika cabang `frontend` ada di repo frontend dan cabang `backend` ada di repo backend, Join tidak punya satu repo untuk menampung keduanya, dan aturan satu-repo melarangnya mengambil dua-duanya.

1. **Kelas Step baru atau tidak** — apakah Join lintas repo adalah Step yang **tidak punya repo** sama sekali (hanya membaca manifest JSON berisi repo + branch + SHA per cabang, tidak pernah checkout), atau ia tetap punya repo tuan rumah dan yang berubah cuma apa yang boleh ia fetch. Yang pertama menambah satu kelas Step ke domain model; yang kedua menjaga model tetap seragam tapi mungkin bohong tentang apa yang sebenarnya terjadi.
2. **Kasus integration test** — "jalankan test yang butuh frontend dan backend hidup bersamaan" adalah kasus yang paling wajar diminta, dan ia butuh kode dua repo di satu tempat. Apakah kasus ini dijawab di sini, dijawab dengan repo ketiga yang khusus (repo test integrasi sebagai tuan rumah yang menarik keduanya sebagai dependensi), atau dinyatakan di luar jangkauan fan-out ber-repo.
3. **Membuka PR di banyak repo** — Join yang wajar untuk fan-out ber-repo adalah "buka PR di tiap repo". Itu berarti satu StepRun melakukan aksi tulis ke beberapa repo lewat GitHub API, bukan lewat git checkout. Apakah itu melanggar aturan satu-repo, atau aturan itu memang cuma soal *checkout* dan bukan soal *API call*. Sambungkan ke ticket 10: token di-mint per repo dengan `repository_ids` sempit.
4. **PR yang harus masuk bersamaan** — kalau frontend dan backend diubah untuk satu kontrak yang sama, dua PR yang di-merge terpisah akan meninggalkan main dalam keadaan rusak di antaranya. Apakah sistem ini punya urusan dengan itu sama sekali, atau itu tanggung jawab manusia dan branch protection.
5. **Output sebuah Join lintas repo** — Output membawa satu Ref. Kalau Join tidak punya repo, Ref-nya apa. Ini pertanyaan yang paling mungkin memaksa perubahan pada ticket 05, jadi jawabnya harus eksplisit.
6. **Kegagalan sebagian** — kebijakan `all`/`any`/`min: N` dari ticket 06 tetap berlaku apa adanya di sini, atau ada sesuatu yang berubah ketika cabang-cabang itu repo yang berbeda.

Rekomendasi awal untuk diuji: Join lintas repo hanya membaca manifest dan bertindak lewat GitHub API, tidak pernah checkout lebih dari satu repo; integration test lintas repo dijawab dengan repo tuan rumah tersendiri, bukan dengan melonggarkan aturan satu-repo.

**Ditambahkan oleh ticket 09** — lubang ini sekarang punya bentuk konkret, bukan deskripsi. Lihat [`prototypes/pipeline-format/d-verdict/03-cross-repo.yaml`](../prototypes/pipeline-format/d-verdict/03-cross-repo.yaml): Step `open-prs` tidak menulis `repo:` sama sekali, jadi ia mewarisi repo config Project dari level Pipeline. Itu **jawaban pilihan kedua sub-pertanyaan 1** yang terjadi secara diam-diam lewat aturan pewarisan, bukan lewat keputusan — dan justru itu yang harus diperiksa: kalau Join lintas repo memang tidak pernah menyentuh kode repo tuan rumahnya, `repo: infra` yang diwariskan itu bohong tentang apa yang terjadi, dan ia tetap membuat control plane me-mint token untuk repo yang tidak dipakai (ticket 10).

**Ditambahkan oleh ticket 23** — sub-pertanyaan 5 menyusut. Bagian **data terstruktur** dari sebuah Output kini sepenuhnya terspesifikasi dan agnostik terhadap repo: mapping bernama, dua tingkat, dipancarkan lewat tag `<factory-output>` di stdout, divalidasi di Runner lalu di control plane. Tidak ada satu pun bagiannya yang mengasumsikan Step punya repo. Maka pertanyaan "kalau Join tidak punya repo, Ref-nya apa" tinggal **soal Ref saja** — dan itu berarti tekanan ke ticket 05 lebih sempit dari yang ditulis di muka: yang mungkin harus berubah cuma apakah Ref boleh kosong, bukan bentuk Output secara keseluruhan.

## Answer

**Lubangnya jauh lebih kecil dari yang ticket ini kira, karena separuhnya sudah ditutup ticket 16 tanpa ada yang menyadarinya.** Tidak ada kelas Step baru, tidak ada Step tanpa repo, dan aturan satu-repo tidak dilonggarkan sedikit pun. Yang berubah cuma isi manifest dan satu aturan validasi.

### Sub-pertanyaan 3 larut, ia tidak pernah jadi pertanyaan

Ticket 16 mengunci `kind: pull-request` sebagai Step bawaan yang tak pernah diklaim Runner, dan menuliskan bahwa ia **lahir sekali per cabang** — itu yang membuat "PR per repo ticket 08" gratis. Maka "buka PR di tiap repo" **bukan** satu StepRun yang menulis ke beberapa repo lewat GitHub API. Ia adalah fan-out Step control-plane: satu StepRun per cabang, masing-masing tetap menyentuh tepat satu repo, masing-masing dilayani token ticket 10 dengan `repository_ids` berisi **satu** id.

Aturan satu-repo tidak pernah tersentuh, jadi dikotomi yang ditawarkan sub-pertanyaan 3 — "melanggar aturan satu-repo, atau aturan itu cuma soal checkout" — tidak perlu dipilih. Keduanya salah alamat.

Ini menjadikan [`03-cross-repo.yaml`](../prototypes/pipeline-format/d-verdict/03-cross-repo.yaml) **salah, dan diperbaiki oleh ticket ini**. `open-prs` di sana ditulis `run: node scripts/open-prs.mjs` di repo `infra` — bentuk yang melanggar dua hal sekaligus: satu StepRun menulis ke dua repo, dan Sandbox memegang `pull_requests:write` yang ticket 16 tolak secara eksplisit ("permukaan tulis berhenti di dua izin"). Bentuk yang benar adalah `kind: pull-request` yang `after:`-nya menunjuk Step fan-out, sehingga ia sendiri ikut lahir per cabang.

### Tidak ada Step tanpa repo, karena tidak tersisa satu pun kandidat

Sub-pertanyaan 1 memilih opsi kedua — Join tetap punya repo tuan rumah — tapi bukan demi keseragaman model. Alasannya lebih kuat: **setelah sub-pertanyaan 3 larut, tidak ada satu pun Step yang benar-benar tidak punya repo.** Satu-satunya kandidat yang pernah diajukan adalah "Step yang cuma membuka PR", dan Step itu ternyata punya repo — repo cabangnya.

Menambahkan kelas Step tanpa repo hari ini berarti menambahkan satu cabang ke domain model untuk nol pengguna. YAGNI, dan kali ini tanpa harga yang harus dinyatakan.

### Yang berubah cuma isi manifest

Ticket 06 memberi Join **manifest JSON + fetch ke satu repo**. Yang berubah: tiap entri manifest sekarang membawa `repo` di samping `key`, `branch`, `sha`, `outcome`, dan data terstruktur Output cabang itu.

Join tetap fetch **repo tuan rumahnya sendiri saja**. Cabang yang tinggal di repo lain hadir sebagai **data**, tidak pernah sebagai kode. Itulah kalimat penuh dari jawaban ini: yang lintas repo adalah *bacaannya*, bukan *checkout*-nya.

Ticket 06 menulis Join sebagai "fetch ketiga branch ke satu repo". Kalimat itu tetap benar apa adanya untuk fan-out dalam satu repo, dan untuk fan-out ber-repo ia menyusut jadi "fetch nol branch" — Join membaca manifest, memutuskan, dan mendorong hasilnya ke branch-nya sendiri di repo tuan rumah. Tidak ada kasus khusus di Runner: ia memfetch branch yang `repo`-nya sama dengan repo StepRun, dan melewati sisanya.

### `repo:` wajib eksplisit di hilir fan-out ber-repo

Keluhan ticket 09 sah: `repo: infra` yang diwariskan diam-diam **bohong** tentang apa yang terjadi, dan ia membuat control plane me-mint token untuk repo yang tak dipakai.

Pewarisan `repo:` dari level Pipeline tetap dipertahankan — ticket 09 mengujinya dan Pipeline satu repo menulis nol `repo:` di level Step, dan itu tetap berharga. Yang ditambahkan adalah satu aturan validasi:

> Sebuah Step **ber-`join:`** yang hulunya adalah fan-out yang cabang-cabangnya menulis `repo:` wajib menulis `repo:` miliknya sendiri. Mewarisi dari level Pipeline adalah error definisi.

Batasnya sengaja sempit: aturan ini **hanya untuk Join** — Step yang mengumpulkan banyak cabang jadi satu StepRun. Step yang lahir **per cabang** (termasuk `kind: pull-request`) tidak ikut, karena ia mewarisi repo dari cabangnya sendiri dan pewarisan itu tidak pernah bohong.

Statis, di dalam satu file (ticket 08: satu file satu Pipeline), jadi ongkosnya nol dan ia menumpang jalur validasi yang sudah ada. Efeknya: penulis dipaksa menyatakan repo mana yang jadi tuan rumah Join, dan token yang di-mint selalu untuk repo yang benar-benar dipakai.

### Ref tetap wajib; ticket 05 tidak berubah sama sekali

Sub-pertanyaan 5 tertutup tanpa sisa. Ticket 23 sudah menyusutkannya jadi "soal Ref saja", dan karena tidak ada Step tanpa repo, **setiap StepRun selalu punya Ref**. Output tidak pernah perlu Ref kosong.

Termasuk Step `kind: pull-request`: Ref-nya adalah Ref cabang yang jadi kepalanya. Ia daun (ticket 24), jadi Ref itu tidak mengalir ke mana-mana — tapi ia ada, dan invarian "Output = satu Ref + data terstruktur" ticket 05 berdiri utuh.

### Integration test lintas repo: ditolak sekarang, harganya dinyatakan

Sub-pertanyaan 2 adalah satu-satunya tempat aturan satu-repo benar-benar menggigit. "Jalankan test yang butuh frontend dan backend hidup bersamaan" **tidak bisa ditulis hari ini**, dan tidak ada jawaban yang diselipkan diam-diam.

Yang ditolak dan alasannya:

- **Melonggarkan aturan jadi "satu repo untuk tulis, banyak repo untuk baca"** — bentuknya menggoda dan sebenarnya koheren (satu repo yang di-checkout, di-commit, dan di-push adalah yang membuat Ref tunggal benar; sisanya read-only di direktori tetangga). Ditolak karena harganya menyebar ke tempat lain: token ticket 10 melebar jadi `contents:read` multi-repo, `repository_ids` berhenti berisi satu id, dan permukaan yang bisa dibujuk prompt injection tumbuh — persis yang ticket 10 sempitkan dengan susah payah. Membayar itu untuk kasus yang belum pernah diminta adalah urutan yang salah.
- **Repo tuan rumah khusus untuk integration test** yang menarik keduanya sebagai dependency atau submodule. Ini jawaban yang benar secara teknis dan nol perubahan di factory — tapi ia memindahkan keputusan ke layout repo tim, dan tidak ada yang berhak memutuskan itu di ticket ini.

Harganya, dinyatakan di muka: **fan-out ber-repo hari ini bisa mengimplementasi dua repo dan membuka dua PR, tapi tidak bisa mengujinya bersama sebelum PR terbuka.** Verifikasi lintas repo terjadi setelah PR ada, di GitHub — dan itu konsisten dengan batas ticket 16 ("factory memiliki segalanya sebelum PR ada, GitHub sejak PR ada"), bukan kebetulan. Pemicunya: permintaan nyata pertama untuk menjalankan test yang butuh dua repo hidup bersamaan. Masuk *Not yet specified*.

### PR yang harus masuk bersamaan: bukan urusan factory

Sub-pertanyaan 4 dijawab tegas: **tidak.** Ticket 16 menghentikan factory di "buka PR, tidak pernah merge", jadi mengoordinasikan merge berarti mengambil kembali wewenang yang baru saja dilepas. Urutan merge adalah urusan manusia dan branch protection.

Yang diberikan gratis dan cukup: setiap PR yang dibuka factory membawa `details_url` ke halaman Run (Commit Status API, ticket 16), dan halaman Run itu memuat seluruh cabang beserta PR saudaranya. Pembaca PR frontend menemukan PR backend dengan satu klik, tanpa satu pun izin tulis tambahan dan tanpa Step yang perlu tahu URL saudaranya.

### Kegagalan sebagian tidak berubah

Sub-pertanyaan 6: `all` (bawaan) / `any` / `min: N` berlaku apa adanya. Cabang yang berasal dari repo berbeda bukan kelas berbeda — manifest-nya sama, `outcome`-nya sama, `minBranches` ticket 06 tetap menutup jebakan himpunan kosong.

Satu konsekuensi yang layak ditulis karena ia mudah dikira bug: dengan `join: any` atas fan-out ber-repo, Step `kind: pull-request` di hilir tetap **lahir per cabang yang sukses saja** — cabang yang gagal tidak punya Ref, jadi tidak ada PR untuk dibuka. Repo yang gagal berakhir tanpa PR sementara repo lain punya, dan itu keadaan yang benar, bukan setengah jadi.

### Konsekuensi ke ticket lain

- **09 (closed)** — `03-cross-repo.yaml` diperbaiki di tempat: `open-prs` jadi `kind: pull-request` dengan `repo:` eksplisit. Ticket 09 tetap otoritas untuk *bentuk* file; ticket ini otoritas untuk isi contoh lintas repo.
- **24 (open)** — dikonfirmasi dari sisi ini: `kind: pull-request` lahir per cabang dan punya repo. Keputusan "daun, tanpa hilir" di ticket 24 adalah yang membuat sub-pertanyaan 4 di sini bisa dijawab tanpa jalur Output baru.
- **10 (closed)** — tidak berubah. `repository_ids` tetap berisi satu id per StepRun; aturan `repo:` eksplisit di atas justru yang menjaganya tetap benar.
- **05, 06, 08 (closed)** — nol koreksi. Ini hasil yang dikejar ticket 08 saat memilih satu StepRun = satu repo, dan ia bertahan.
- **13 (open)** — Graph lintas repo merender nama repo sebagai bagian Key cabang, dan simpul `kind: pull-request` per cabang. Tidak ada bentuk baru untuk dirender.
