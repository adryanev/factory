# Semantik eksekusi DAG: fan-out, join, kegagalan, cancel

Type: grilling
Status: resolved
Blocked by: 02, 05, 14

## Question

Ketika sebuah PipelineRun berjalan, apa aturan persis yang menentukan step mana berjalan, kapan, dan apa yang terjadi ketika ada yang salah?

Ini inti sistemnya. Contoh yang jadi acuan: `plan → {agent A, agent B, agent C} → pick-best → test`, dengan A/B/C di tiga worker berbeda.

1. **Fan-out** — bagaimana satu step menghasilkan N cabang. Ditulis eksplisit di definisi (tiga step bernama), atau satu step dengan `parallelism: 3`, atau dinamis dari keluaran step sebelumnya? Yang dinamis paling kuat dan paling mahal.
2. **Penamaan branch** — tiap cabang mendorong ke branch git yang berbeda. Skema penamaan yang menjamin unik lintas run, lintas retry, dan lintas cabang. Kapan branch itu dibersihkan.
3. **Join** — step `pick-best` menerima tiga branch. Bagaimana ia diberi tahu nama-nama itu — variabel lingkungan, file manifest, atau argumen? Bagaimana ia bekerja: clone ketiganya jadi tiga worktree, atau fetch ketiganya ke satu repo lalu bandingkan?
4. **Kegagalan sebagian** — 2 dari 3 cabang sukses, 1 gagal. Apakah join tetap berjalan dengan dua masukan, atau seluruh run gagal? Ini kebijakan per-step atau per-pipeline?
5. **Retry** — apa yang boleh diulang otomatis. Perhatikan bahwa agent run tidak deterministik dan berbiaya uang: retry bukan keputusan gratis. Apakah retry membuat StepRun baru atau menimpa yang lama?
6. **Cancel** — user menekan cancel selagi tiga agent berjalan di tiga mesin. Bagaimana sinyal itu sampai ke worker yang sedang long-poll (koneksinya outbound-only). Berapa lama boleh menunggu sebelum dipaksa mati. Apa yang terjadi pada branch setengah jadi.
7. **Timeout** — sandcastle sudah punya idle/completion timeout. Batas apa yang jadi milik control plane, dan mana yang diserahkan ke sandcastle. Hindari dua timeout yang saling balapan.
8. **Penjadwalan** — apa yang terjadi kalau tidak ada worker cocok yang tersedia: antre selamanya, atau gagal setelah batas waktu.
9. **Step yang menunggu manusia** — ticket 14 memutuskan mekaniknya; di sini putuskan akibatnya pada DAG. Sebuah cabang bisa menggantung berjam-jam menunggu jawaban. Apakah cabang lain tetap jalan? Apakah run yang menunggu manusia masih menghitung waktu terhadap timeout? Bagaimana cancel mencapai step yang sedang menunggu, bukan sedang bekerja?

Zoom ke temuan ticket 02 untuk pola yang sudah terbukti, dan pakai istilah yang dipatok di ticket 05.

## Answer

Tiga dari sembilan pertanyaan ternyata sudah punya jawaban dan tidak dibuka lagi: **penamaan branch** dikunci ticket 14 (`run/<run-id>/<key>/t<turn>-a<attempt>`, dibersihkan saat Run berakhir), **mekanik cancel** dikunci ticket 07 dan 02, dan **fan-out dinamis** sudah dinyatakan `CONTEXT.md`. Yang tersisa dijawab di bawah.

### Satu jalur fan-out, dua sumber daftar

Tidak ada `parallelism: N`, dan tidak ada bentuk statis. Cabang selalu lahir dari sebuah **daftar**, dan daftar itu boleh bersumber dari **konstanta di definisi Step** (`over: ["agent-a","agent-b","agent-c"]`) atau dari **Output step sebelumnya** (`over: ${{ plan.variants }}`). Contoh acuan `plan → {A, B, C}` di badan ticket ini terbaca statis, dan itu diungkapkan sebagai bentuk pertama — bukan sebagai mekanisme kedua.

Dua bentuk fan-out akan berarti dua jalur pembentukan Key, dua jalur Join, dan dua jalur retry, demi kenyamanan sintaks yang bisa dibeli jauh lebih murah lewat `over:` berisi konstanta.

**Key ditulis eksplisit** — tiap elemen daftar wajib punya field `key`, tervalidasi skema, dan **duplikat menggagalkan Run saat fan-out**, bukan digabung diam-diam. Key turunan-hash ditolak karena `CONTEXT.md` menuntut Key terbaca manusia: ia muncul di nama Branch, di log, dan di UI, dan `a3f9c1` gagal di ketiganya.

**Fan-out bersarang tidak dibangun.** Key berubah jadi tupel, nama branch bercabang dua tingkat, dan Join harus menyatakan tingkat mana yang ia gabungkan — tiga keputusan baru untuk kebutuhan yang belum punya pemicu. Ini masuk *Not yet specified*, bukan *Out of scope*: ia di dalam destination.

### Kebijakan kegagalan sebagian dimiliki Join

`all` (default) / `any` (≥1 sukses) / `min: N`, ditulis pada Step Join — bukan pada Pipeline, dan bukan pada cabang yang gagal. Yang tahu apakah dua dari tiga cukup adalah `pick-best`. Pipeline dengan dua Join berkebutuhan beda tidak bisa diungkapkan kalau kebijakannya global.

`all` jadi default supaya "melanjutkan diam-diam dengan data kurang" tidak pernah terjadi tanpa seseorang menuliskannya.

### Satu bidang, satu pertanyaan

Ticket 02 menamai akar kelas bug `continueOn` Argo: satu bidang menjawab dua pertanyaan. Di sini keduanya dipisah dengan cara **tidak menyimpan yang kedua**.

```
step_run.outcome  ∈ { succeeded, failed, cancelled, skipped }   -- disimpan
"hilir dijadwalkan"                                              -- dihitung: outcome cabang + kebijakan Join
run.outcome                                                      -- dihitung: dari Step terminal saja
```

Konsekuensinya harus dinyatakan terang: **Run bisa `succeeded` walaupun ada StepRun `failed`**, kalau Join-nya `any`. Itu bukan kelonggaran, itu justru inti pemisahannya.

`skipped` berarti **tidak pernah dijalankan karena keputusan Graph** — bukan kegagalan. Ia lahir ketika hulu `failed`/`cancelled` dan kebijakan Join tidak mengizinkan hilir jalan, dan ia **menyebar ke hilir**: turunan dari `skipped` juga `skipped`, tidak pernah `failed`.

Step terminal = Step tanpa hilir di definisi. `run.outcome` dihitung menurut presedensi:

| | |
|---|---|
| ada terminal `failed` | Run **`failed`** |
| ada terminal `cancelled` (tanpa `failed`) | Run **`cancelled`** |
| ≥1 terminal `succeeded`, sisanya `skipped` | Run **`succeeded`** |
| semua terminal `skipped` | Run **`failed`** |

Baris terakhir adalah pasangan dari `minBranches` di bawah: Run yang tidak menghasilkan apa pun tidak boleh mengaku sukses.

### Retry: satu penghitung, default 2

Ketegangan nyata: agent run tidak deterministik dan berbiaya uang, jadi retry otomatis membakar duit. Tapi ticket 07 sudah mengunci **satu penghitung** — lease hilang memakan jatah `attempt` yang sama dengan kegagalan biasa, dan justru itu yang memberi perlindungan poison-pill. Artinya `attempts: 1` bukan berarti "tanpa retry", melainkan "satu Runner mati = StepRun mati".

**Default `attempts: 2`.** Cukup untuk selamat dari satu Runner mati; harga satu agent run kedua diterima sebagai ongkos ketahanan. Step non-agent boleh menaikkannya.

Dua penghitung terpisah (`attempts` + `infraAttempts`) **ditolak**: lebih tepat secara semantik, tapi membatalkan keputusan ticket 07 dan membuka lagi lubang poison-pill — StepRun yang membunuh Runner-nya akan diulang tanpa batas atas jatah infra.

Retry **menimpa baris yang sama** dan menaikkan `attempt` (skema ticket 14). Riwayat percobaan hidup di nama branch dan blob log per attempt, bukan di baris tambahan.

### Satu jam, dipegang control plane

`timeout: 30m` wall-clock per StepRun, ditegakkan lewat lease dan heartbeat. Timeout idle dan completion milik sandcastle **dimatikan** atau diset jauh di atasnya sehingga tidak pernah menang. Dua jam yang berjalan bersamaan membuat pertanyaan "siapa yang membunuh StepRun ini" tidak terjawab dari log.

Konsekuensi gratis dari ticket 14: StepRun `awaiting-human` **tidak punya lease**, jadi ia otomatis tidak menghitung terhadap jam mana pun. Tidak perlu aturan tambahan.

### Tidak ada Runner cocok: antre, jangan gagal

Antre tanpa batas waktu default. StepRun yang tidak terjadwal lebih dari 5 menit **ditandai di UI**; `unschedulableAfter` tersedia opsional per Pipeline untuk yang memang tidak boleh menggantung.

Kegagalan karena mesin sedang mati bukan kegagalan pekerjaan. Ini pola yang sama dengan ticket 14: visibilitas menggantikan timer.

### Mekanik Join: manifest JSON, satu repo

Control plane mengumpulkan Output tiap cabang lewat kueri DB (pola ticket 02: *"Join cukup kueri DB"*), menuliskannya sebagai **satu file JSON** di working dir Sandbox, dan menaruh path-nya di env var. Step Join melakukan `git fetch` ketiga branch ke **satu repo** — tiap cabang jadi ref lokal, dibandingkan dengan `git diff main..agent-a`.

Env var per cabang ditolak: pecah begitu jumlah cabang tidak diketahui saat definisi ditulis, yang justru kondisi normal setelah fan-out selalu dinamis. Tiga worktree terpisah ditolak: tiga checkout penuh, tiga kali disk dan waktu, untuk sesuatu yang `git diff` sudah berikan.

### Daftar kosong: `minBranches`, default 1

`all` atas himpunan kosong bernilai benar — artinya pipeline "sukses" tanpa mengerjakan apa pun. Itu jebakan yang harus ditutup di default, bukan di dokumentasi.

`minBranches` ditulis di sisi fan-out, **default `1`**. Daftar kosong menggagalkan StepRun fan-out. Pipeline yang memang boleh menghasilkan nol cabang harus menulis `minBranches: 0`, dan barulah Join berjalan dengan daftar kosong.

### Cabang yang menunggu manusia tidak menahan cabang lain

Tidak ada barrier: cabang lain terus jalan. Konsekuensi yang diterima terbuka — **Join `all` menunggu selamanya** kalau satu cabang menggantung menunggu manusia yang tidak pernah menjawab. UI menandai Run yang tersumbat; cancel adalah jalan keluarnya.

Timeout khusus Join **ditolak**: ia menghidupkan lagi jam kedua yang baru saja ditolak, dan bertabrakan dengan keputusan ticket 14 bahwa Question tidak punya kadaluarsa.

### Cancel: 30 detik, dan branch yatim dibiarkan

Cancel sampai lewat heartbeat (≤10 detik, ticket 07) → **SIGTERM ke seluruh process group** (ticket 02) → tunggu **30 detik** → SIGKILL. Angka tetap, tanpa opsi konfigurasi: satu angka yang bisa dijelaskan lebih baik daripada satu kolom yang harus diuji.

Runner yang tidak pernah heartbeat lagi tidak butuh jalur khusus — lease kedaluwarsa lalu sweep (ticket 07).

**StepRun `cancelled` tidak punya Output**, jadi tidak ada apa pun yang mengalir; hilirnya `skipped`. Branch yang terlanjur ter-push sebagian jadi **yatim** dan dibersihkan GC saat Run berakhir (ticket 15). Tidak ada usaha membersihkannya saat cancel: proses yang sedang dibunuh adalah tempat terburuk untuk menaruh logika pembersihan.

### Graph dimaterialisasi hibrida, cabang lahir dalam satu transaksi

`CONTEXT.md` menyatakan simpul Graph "**sebagian** lahir saat Run berjalan". Kata *sebagian* itu berarti: semua Step yang **tidak** berada di belakang fan-out dimaterialisasi jadi baris StepRun **saat Run dibuat**; cabang lahir saat Step fan-out mencapai `succeeded`. Sebelum lahir, UI menampilkan satu simpul placeholder "menunggu fan-out" — supaya bentuk Run bisa dilihat sebelum ia jalan.

Kelahiran cabang adalah **satu transaksi Postgres** yang memuat transisi Step fan-out ke `succeeded` **dan** seluruh baris cabang sekaligus. Entah 50 baris ada semua, entah tidak ada satu pun dan Step fan-out belum sukses — attempt berikutnya mengulang seluruhnya. Nol logika idempotensi tambahan; kunci idempotensi per cabang membeli masalah yang transaksi sudah selesaikan gratis.

Retry Step fan-out itu sendiri bukan masalah: Output hanya ada kalau Step sukses, jadi cabang tidak pernah lahir dari attempt yang gagal.

### `ready` digerakkan kejadian, sweep sebagai jaring pengaman

Saat StepRun mencapai state terminal, **di transaksi yang sama** hilirnya dievaluasi dan `ready_at` diisi bagi yang syaratnya sudah terpenuhi. Sweep periodik yang sudah ada di ticket 07 untuk lease kedaluwarsa sekaligus menangkap hilir yang lolos karena crash — ia numpang, bukan komponen baru. Ini juga pola ticket 02: sweep dijalankan sebelum listener dibuka, bukan sebagai penggerak utama.

### Rewind: bentuknya diputuskan, fiturnya tidak dibangun

Ticket 14 mewariskan wilayah ini ke sini, dan yang diminta adalah **bentuknya**, bukan fiturnya.

**Rewind melahirkan Run baru**, dengan `parent_run_id` dan penanda titik fork (StepRun + turn). `CONTEXT.md` menyatakan Graph dimiliki Run, jadi dua garis waktu di satu Graph akan melanggar kosakata sendiri dan memaksa tiap kueri Graph bertanya "garis waktu mana". StepRun hilir yang terlanjur jalan **tidak disentuh** — ia milik Run lama, dan Run lama tetap terbaca sebagai riwayat yang jujur.

Tombolnya tidak dipasang sekarang. Yang penting: memilih bentuk ini berarti **tidak ada satu pun keputusan lain di ticket ini yang perlu ditinjau ulang** saat tombol itu akhirnya dipasang.

### Konsekuensi ke ticket lain

- **09** — format definisi wajib memuat `over:`, `key` per elemen, `minBranches`, kebijakan Join (`all`/`any`/`min`), `timeout`, `attempts`, dan `unschedulableAfter`, di samping `ask:`/`onReject:`/`humanTimeout:`/`onHumanTimeout:` dari ticket 14. Masih diblokir ticket 08.
- **12** — keputusan "sandcastle tidak boleh memegang jam" adalah kebutuhan konkret yang harus diuji terhadap API-nya. Sekarang unblocked.
- **13** — panel monitoring wajib merender simpul placeholder "menunggu fan-out", state `skipped`, dan penanda "tersumbat menunggu manusia". Sekarang unblocked.
- **07** — keputusan satu-penghitung dipertahankan utuh; `unschedulableAfter` menambah satu klausa opsional ke kueri klaim, bukan penjadwal baru.
- **02** — peringatan `continueOn` dipatuhi lewat "tidak menyimpan nilai turunan", bukan lewat dua kolom.
