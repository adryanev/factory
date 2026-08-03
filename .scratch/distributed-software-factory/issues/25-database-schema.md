# Skema DB

Type: grilling
Status: resolved
Blocked by: —

## Question

Dua puluh lima ticket sudah memutuskan perilaku sistem ini tanpa pernah menuliskan satu pun tabel. Ticket ini menulisnya. Tapi ia bukan pekerjaan menyalin — sebagian besar keputusan sudah dikunci, dan yang tersisa justru pertanyaan yang selama ini bisa ditunda karena tidak ada yang memaksa memilih bentuk penyimpanan.

Yang sudah dikunci dan tidak dibuka lagi di sini: batas aggregate (ticket 05 — Run adalah aggregate penjadwalan, log dan heartbeat ditulis di luarnya, Runner aggregate terpisah), materialisasi Graph hibrida dalam satu transaksi (ticket 06), kueri leasing dengan partial unique index (ticket 07, dipakai ulang ticket 24), dan siapa memiliki credential (ticket 10).

Yang harus diputuskan:

1. **Query layer dan tooling migrasi.** Notes map mengunci skema Zod di `shared` dipakai ketiganya, tapi tidak mengunci bagaimana ia bertemu Postgres. Drizzle (skema TypeScript jadi sumber kebenaran, migrasi dibangkitkan), Kysely (query builder saja, migrasi ditulis tangan), atau SQL mentah plus `node-pg-migrate`. Yang memaksa ini jadi keputusan, bukan selera: kueri klaim ticket 07 memakai `FOR UPDATE SKIP LOCKED`, partial unique index, dan `runner.tags @> requires` — kalau tooling-nya tidak bisa menyatakan ketiganya tanpa escape hatch, seluruh jalur terpanas sistem ini hidup di string SQL mentah sementara sisanya tidak, dan itu dua gaya di satu repo.

2. **Bentuk id, dan kendala yang tidak terlihat sampai sekarang.** Ticket 14 mengunci nama branch `run/<run-id>/<key>/t<turn>-a<attempt>` — artinya `run-id` disalin manusia ke `git checkout` dan harus aman sebagai komponen ref git. UUIDv4 (36 karakter acak) membuat nama branch tidak terbaca; bigint berurutan membocorkan laju pemakaian dan tidak bisa dibangkitkan klien; UUIDv7 terurut waktu tapi tetap panjang. Apakah ada bentuk id pendek yang terurut, dan apakah id yang tampil di branch boleh berbeda dari primary key.

3. **Tabel dan indeks yang dituntut kueri, bukan yang dituntut entitas.** Tiga pembaca menetapkan biayanya di muka dan ketiganya sering: kueri klaim ticket 07 (`ready` + tag containment + `ORDER BY ready_at`), lencana-sebagai-kueri ticket 19 (ini keputusan penopang di sana — kalau lencana mahal, seluruh argumen "state yang terbaca, bukan kejadian yang dikirim" runtuh), dan halaman "Menunggu saya" diurutkan umur. Indeks untuk ketiganya diputuskan di sini, termasuk apakah tag containment butuh GIN dan apakah `tags` disimpan sebagai `jsonb` atau `text[]`.

4. **Giliran dan attempt di dalam baris.** Ticket 18 menyatakan terang apa yang selama ini tersirat: giliran melahirkan baris `step_runs` baru, `attempt` menghitung ulang di dalamnya, dan ticket 06 mengunci retry menimpa baris yang sama. Jadi satu Step dalam satu Run punya banyak baris `step_runs`, dibedakan `turn`. Kunci uniknya apa — `(run_id, step_key, branch_key, turn)`? Dan `branch_key` untuk Step non-fan-out diisi apa: `NULL` (yang membuat unique index bocor karena `NULL` tidak pernah sama dengan `NULL`) atau sentinel.

5. **Apa yang disimpan dan apa yang dihitung.** Ticket 06 mengunci hanya `step_run.outcome` yang disimpan; "hilir dijadwalkan" dan `run.outcome` dihitung, karena menyimpan nilai turunan adalah akar bug `continueOn` ticket 02. Konsekuensinya di skema: apakah `runs` benar-benar tidak punya kolom status sama sekali, dan kalau tidak punya, daftar Run di UI menghitung status ratusan Run tiap kali halaman dibuka. Kalau jawabannya kolom turunan yang di-cache, aturan invalidasinya harus ditulis — dan itu persis bentuk yang ticket 06 tolak. Salah satu dari dua harus mengalah, dengan alasan.

6. **Enum di DB atau cek di aplikasi.** Status StepRun (`ready`/`running`/`awaiting-human`/`succeeded`/`failed`/`skipped`/`cancelled`), `desired_state` Runner ticket 07, `onReject` ticket 14, `kind` Question ticket 14, kebijakan Join ticket 06. Enum Postgres membuat nilai tak sah mustahil ditulis tapi mengubahnya butuh migrasi; `text` + `CHECK` lebih longgar. Aturan map "buat state tak sah mustahil ditulis" condong ke yang pertama, tapi harganya harus dinyatakan.

7. **Append-only ditegakkan di level DB.** Ticket 11 mengunci `audit_log` append-only *di level DB*, bukan disiplin aplikasi. Mekanismenya diputuskan di sini: `REVOKE UPDATE, DELETE` dari role aplikasi, atau trigger `BEFORE UPDATE ... RAISE`. Yang pertama menuntut role DB terpisah — dan kalau kita mengambil role terpisah, pertanyaan berikutnya adalah role mana yang dipakai migrasi, karena migrasi jelas harus boleh menyentuhnya.

8. **Kolom yang berperilaku beda dari semua kolom lain.** Ticket 20 mengunci `cost_usd` kumulatif lintas attempt dan tidak pernah di-reset — satu-satunya kolom yang tidak ikut rollback saat retry menimpa baris. Kalau retry menimpa baris yang sama (ticket 06), penulisan retry harus dengan sengaja tidak menyentuh dua kolom. Apakah itu ditegakkan oleh bentuk (kolom biaya pindah ke tabel sendiri) atau oleh disiplin di satu fungsi.

9. **Secret dan credential.** Ticket 10 mengunci AES-256-GCM dengan AAD = id secret + id Principal pemilik, master key dari file. Tata letak kolomnya (ciphertext, nonce, tag, key version) dan apakah rotasi master key butuh kolom versi diputuskan di sini. Ticket 20 menambahkan dua kolom atribusi terpisah di `runs` sesuai larangan ticket 10.

10. **Retensi yang digerakkan state Postgres.** Ticket 15 mengunci tiga kebijakan terpisah (Artifact 90 hari sejak Run berakhir, Branch saat Run berakhir, Session saat StepRun tak lagi `awaiting-human` **dan** Run berakhir) dan menolak lifecycle rule bucket justru supaya pemicunya adalah state Postgres. Ticket 18 menambah log 30 hari. Empat sweep membaca empat predikat berbeda — indeks untuk keempatnya, dan apakah "Run berakhir" punya timestamp tersimpan atau ikut dihitung (yang membenturkannya dengan sub-pertanyaan 5).

11. **Dedup yang hidup di constraint, bukan di kode.** Ticket 18 mengunci dedup log di primary key `(step_run_id, attempt, offset)`; ticket 22 mengunci dua lapis dedup webhook — `X-GitHub-Delivery` 24 jam dan kunci natural `(Pipeline, SHA)`. Yang pertama butuh tabel dengan TTL dan pembersihnya; yang kedua unique index parsial atas Run yang belum berakhir, atau atas semuanya. Keduanya diputuskan di sini karena keduanya adalah constraint, bukan logika.

12. **Cache definisi Pipeline.** Ticket 08 menyebutnya turunan murni yang boleh dihapus kapan saja dan tidak pernah dibaca jalur eksekusi; ticket 22 justru menjadikannya **wajib** karena pemetaan webhook→Pipeline butuh tahu pipeline apa yang ada tanpa menembak GitHub tiap kejadian. Dua sifat itu masih bisa hidup bersama, tapi tabelnya harus dirancang supaya "boleh dihapus" tetap benar — artinya jalur pemulihan saat cache kosong dan webhook datang harus ada, dan itu bentuk skema, bukan cuma kode.

13. **Snapshot definisi di dalam Run.** Ticket 08 mengunci Run menyimpan definisi plus isi semua file prompt. Apakah itu satu kolom `jsonb`, satu blob di Garage (ticket 15 menyatakan semua artefak ke blob tanpa jalur inline Postgres — apakah aturan itu mengikat di sini juga), atau tabel tersendiri.

Rekomendasi awal untuk diuji: satu tabel `step_runs` dengan `turn` di kunci uniknya dan sentinel untuk `branch_key` non-fan-out, enum Postgres untuk status tertutup, `REVOKE` untuk audit log, dan tidak ada kolom status turunan di `runs` sampai daftar Run terbukti lambat dengan angka.

## Answer

**Tiga dari empat rekomendasi awal dibalik**, dan yang membalikkannya bukan selera melainkan fakta yang diperiksa saat sesi: `NULLS NOT DISTINCT` membuat sentinel tidak perlu, himpunan nilai "tertutup" terbukti sudah tumbuh sekali, dan `REVOKE` ternyata menggantungkan jaminan pada langkah operator yang bisa terlewat diam-diam. Yang bertahan justru yang paling dicurigai — tidak menyimpan status turunan — tapi ia bertahan dalam bentuk yang lebih tajam daripada yang ditulis di muka.

### Yang membentuk seluruh ticket: turunan yang bergerak versus fakta yang sudah selesai

Ticket 06 melarang menyimpan nilai turunan, dan larangan itu punya alasan yang sangat spesifik dari ticket 02 — satu bidang menjawab dua pertanyaan adalah akar kelas bug `continueOn` Argo. Dibaca harfiah, larangan itu berarti `runs` tidak boleh punya kolom status sama sekali, dan daftar Run di UI harus menghitung ulang tiap render.

Memeriksanya lebih dekat membelah masalahnya jadi dua yang selama ini tertukar:

- **Status Run yang sedang berjalan** — "berjalan", "menunggu manusia", "tersumbat" — hanyalah hitungan status `step_runs`. Murah, satu agregat, nol kebijakan.
- **Vonis akhir** butuh kebijakan Join `all`/`any`/`min: N` dari snapshot definisi tiap Run. Ini bukan agregat SQL sama sekali; ia evaluasi Graph di kode aplikasi. Daftar 200 Run berarti 200 evaluasi Graph.

Dan vonis akhir punya sifat yang tidak dimiliki turunan mana pun di ticket 06: **begitu Run berakhir, ia tidak bisa berubah lagi.**

Maka: `runs.outcome` dan `runs.ended_at` **nullable, ditulis sekali** oleh transaksi yang mengakhiri Run. NULL berarti belum berakhir. Jalur penjadwalan tidak pernah membacanya — ia membaca `step_runs`. Ini bukan yang ticket 06 larang, karena yang dilarang adalah membaca turunan tersimpan untuk **mengambil keputusan penjadwalan selagi Run bergerak**, dan kolom ini baru ada setelah tidak ada lagi yang bergerak.

Bonus yang tidak diduga saat ticket dibuka: `ended_at` adalah persis predikat yang dituntut keempat sweep retensi ticket 15 dan 18 ("sejak Run berakhir"). Tanpanya keempatnya mahal. Satu kolom melunasi dua sub-pertanyaan.

Harga yang dinyatakan: *"penjadwal tidak boleh membaca kolom ini"* adalah disiplin, bukan bentuk. Tidak ada yang mencegahnya secara struktural.

### Tooling: Drizzle, dan batas dua gayanya ditarik di muka

Ketiga konstruksi terpanas diverifikasi didukung tanpa escape hatch sebelum memilih: `.for('update').skipLocked()`, partial index lewat `.where(sql\`\`)`, dan containment lewat `sql` template. Warren adalah preseden langsung (TS + Drizzle, dan kode `run_inbox` atomic-claim-nya bisa dipinjam — ticket 00 sudah menandainya).

Jalur SQL-first dipertimbangkan serius karena mayoritas kueri yang **sulit** di sistem ini adalah SQL. `sqlc-gen-typescript` gugur pada fakta: beta 0.1.3 sejak preview Desember 2023 sementara sqlc core sudah v1.31.1 — dan ticket 12 baru saja mengunci kebijakan pin-eksak plus contract test justru untuk dependensi yang bergerak diam-diam. Menaruh seluruh lapisan data di plugin beta yang bergerak lambat adalah kelas risiko yang sama, tanpa preseden TS di prior art kita. `pgTyped` dan `SafeQL` layak tapi menuntut Postgres hidup saat lint atau codegen, dan tidak satu pun mengurus migrasi.

Batas dua gaya ditarik sekarang supaya tidak jadi temuan belakangan: **skema, migrasi, dan seluruh CRUD di Drizzle; tiga hal ditulis SQL tangan** — trigger append-only, kueri klaim, dan sweep retensi. Ketiganya punya contract test.

### Id: satu identitas, dan kendala yang selama ini tidak tercatat

Ticket 14 menaruh `run-id` di nama branch, yang berarti manusia menyalinnya ke `git checkout`. Kendala itu tidak pernah ditulis di ticket mana pun, dan ia menggugurkan UUIDv4.

Dipilih: **UUIDv7 di-encode base32 dengan prefiks tipe**, pola TypeID — `run_01jq8z3k7m4n5p6q7r8s9t0v1w`. Satu identitas, bukan dua.

Empat sifat yang dibayar sekaligus:

1. **Terurut waktu** ⇒ lokalitas indeks tepat di daftar yang paling sering dibuka (Run terbaru, Question terlama menurut ticket 19).
2. **Aman sebagai komponen ref git.**
3. **Bisa dibangkitkan klien** ⇒ Runner punya idempotency key gratis, yang langsung dipakai ticket 26.
4. **Prefiks membuat id menjelaskan dirinya** saat muncul telanjang di log tiga komponen sekaligus.

Sifat ketiga menghasilkan konsekuensi yang baru terlihat di sub-pertanyaan 9: AAD enkripsi ticket 10 adalah id secret + id Principal pemilik, jadi **id harus sudah ada sebelum baris dienkripsi**. Dengan id yang dibangkitkan server saat INSERT itu mustahil tanpa dua langkah. Dengan id klien ia gratis.

Ditolak: nomor Run berurut per Project. Ia lebih cantik di nama branch (`run/128/...`) dan sesuai harapan orang dari CI, tapi penghitungnya adalah row lock yang ditahan selama **seluruh transaksi materialisasi Graph ticket 06** — jadi pembuatan Run terserialisasi per Project demi kosmetik.

### Kunci unik `step_runs`, dan constraint owainlewis yang ternyata tidak dibutuhkan

Ticket 18 sudah menyatakan terang bahwa giliran melahirkan baris StepRun baru dan `attempt` menghitung ulang di dalamnya. Maka kunci naturalnya **(run_id, step_key, branch_key, turn)**.

`branch_key` NULL untuk Step non-fan-out, dengan `unique().on(...).nullsNotDistinct()` — terverifikasi didukung Drizzle, menuntut PG15+. NULL berarti apa adanya: Step ini tidak punya Key. Sentinel `''` ditolak karena ia kebohongan yang berpakaian seperti Key, dan aturan penamaan map menolak nama yang butuh komentar di sebelahnya.

Constraint ini sekaligus yang menegakkan aturan ticket 06 **"Key duplikat menggagalkan Run saat fan-out"** — struktural, bukan cek di kode.

**Temuan:** ticket 00 mengadopsi partial unique index `one_active_attempt_per_execution` milik owainlewis/factory sebagai "constraint fisik terakhir". Di model kita ia **tidak diperlukan**: owainlewis menyimpan tiap attempt sebagai baris baru sehingga butuh index untuk mencegah dua attempt aktif, sementara ticket 06 mengunci retry **menimpa baris yang sama**. Satu StepRun satu baris ⇒ dua attempt aktif mustahil ditulis, diberikan primary key secara gratis. Yang tetap diadopsi: `FOR UPDATE SKIP LOCKED` + UPDATE bersyarat + cek baris terpengaruh, dan klausa `count(*) < $slots` ticket 07 sebagai pagar.

Partial unique index tetap dipakai, tapi di dua tempat lain yang benar-benar memerlukannya (lihat bagian dedup).

### Koreksi ticket 14: nama branch bertabrakan pada fan-out

Ticket 14 menulis `run/<run-id>/<step-key>/t<turn>-a<attempt>` — **tanpa Key**. Untuk Step yang di-fan-out 50 cabang, kelima puluh StepRun-nya menghasilkan nama branch identik dan saling menimpa di remote. `CONTEXT.md` sendiri menyatakan Key "muncul di nama Branch". Template itu ditulis sebelum ticket 06 mengunci fan-out, dan tabrakannya tidak pernah terlihat.

Template yang berlaku:

```
run/<run-id>/<step-key>/<branch-key>/t<turn>-a<attempt>
run/<run-id>/<step-key>/t<turn>-a<attempt>            # Step tanpa Key
```

Ini membuat keamanan Key sebagai komponen ref git jadi pertanyaan nyata, dan pertanyaannya lebih tajam dari kelihatannya: **Key untuk fan-out dinamis lahir dari Output agent**, bukan ditulis penulis Pipeline. Ia teks yang dibangkitkan model.

Dipilih: **Key dideklarasikan sebagai tipe berkendala di bahasa tipe mini ticket 23** — `[a-z0-9][a-z0-9._-]{0,63}` — sehingga agent yang menulis `Payment Service` mendapat umpan balik dan memperbaiki dirinya **di dalam giliran**, lewat mekanisme perbaikan-diri yang ticket 23 temukan sudah ada di sandcastle.

Normalisasi slug ditolak, dan alasannya bukan selera: `Frontend` dan `frontend` menormalisasi jadi satu, sementara cek Key duplikat ticket 06 berjalan **sebelum** normalisasi — jadi tabrakan itu lolos cek dan baru muncul sebagai branch yang saling menimpa. Ini berbeda dari normalisasi slug `key` Artifact di ticket 15, di mana keunikan tidak pernah dijanjikan; asimetrinya punya alasan yang bisa ditulis.

### Himpunan nilai tertutup: `text` + CHECK

Jaminannya identik dengan pgEnum — nilai tak sah ditolak DB, daftar nilainya tetap hidup sekali saja di skema Drizzle. Bedanya hanya evolusi: CHECK di-drop lalu di-add di kedua arah, sementara pgEnum bisa `ADD VALUE` murah tapi **membuang** nilai menuntut tipe dibuat ulang beserta seluruh kolom yang memakainya.

Yang memutuskan: bukti bahwa himpunan ini tumbuh sudah ada di map. `kind` Question dikunci **tiga tertutup** di ticket 14, lalu ticket 15 membuka `edit-artifact` dan jadi empat.

Yang hilang dan diterima: tipe pgEnum berbeda tidak bisa dibandingkan satu sama lain, jadi `desired_state` tidak akan pernah tertukar dengan status StepRun bahkan di SQL mentah — kelas bug yang CHECK tidak tutup, dan jalur panas kita memang SQL mentah. Dinyatakan sebagai harga, bukan diabaikan.

### Append-only: trigger, bukan REVOKE

`audit_log` mendapat trigger `BEFORE UPDATE OR DELETE` yang `RAISE EXCEPTION`.

Alasan pokoknya bukan kekuatan jaminan — keduanya sama-sama bisa dilewati pemilik tabel — melainkan **siapa yang harus melakukan sesuatu agar jaminan itu ada**. Trigger ikut di dalam migrasi, jadi setiap instalasi mendapatkannya tanpa satu langkah operator pun. `REVOKE` menuntut dua role DB, dua connection string, dan satu langkah pembuatan role di packaging ticket 28 — yang kalau terlewat, jaminannya hilang **tanpa suara**. Itu kelas kegagalan yang sama persis dengan installer macOS separuh jadi yang ticket 28 tandai: konfigurasi yang salah menghasilkan sistem yang terlihat sehat dan diam-diam tidak dilindungi.

Biaya runtime nol: trigger hanya menyala pada UPDATE/DELETE yang secara sah tidak pernah terjadi. `RULE ... DO INSTEAD NOTHING` ditolak karena ia menelan pelanggaran tanpa suara; `RAISE` membuatnya berisik.

Role terbatas tetap layak, tapi ia pertanyaan yang lebih luas dari audit log dan diserahkan ke ticket 28.

---

*Enam keputusan berikut diambil tanpa kehadiran user (lihat "Yang belum diuji" di akhir).*

### Biaya: tabel terpisah, sehingga anomalinya lenyap

Ticket 20 mengunci `cost_usd` kumulatif lintas attempt dan tidak pernah di-reset, dan menyebutnya "satu-satunya kolom yang berperilaku begitu". Dengan retry menimpa baris yang sama (ticket 06), itu berarti penulisan retry harus **dengan sengaja tidak menyentuh dua kolom** — aturan yang hidup di kepala penulis kode.

Dipilih: **`step_run_costs`, insert-only, satu baris per attempt** — `(step_run_id, attempt)` sebagai primary key, berisi token, `cost_usd`, dan `price_version`. Retry tidak bisa menimpanya karena retry tidak menulis ke sana sama sekali. "Kumulatif" jadi `SUM` biasa, dan tidak ada yang perlu di-reset karena tidak ada yang pernah ditimpa.

Kolom yang berperilaku aneh lenyap alih-alih dijaga disiplin — dan biaya per attempt jadi terlihat gratis, yang berguna persis saat menyelidiki StepRun yang gagal berulang. Aturan ticket 20 "dihitung sekali saat StepRun berakhir, disimpan bersama `price_version`" berlaku apa adanya per baris attempt.

Dua kolom atribusi ticket 10/20 tetap di `runs` (`triggered_by_principal_id`, `credential_principal_id`), karena keduanya sifat Run, bukan sifat attempt.

### Secret: kolom eksplisit, dan `key_version` yang membuat rotasi bisa diinterupsi

`secrets(id, project_id, owner_principal_id, name, ciphertext, nonce, auth_tag, key_version, ...)` — nonce dan auth tag sebagai kolom terpisah, bukan disambung jadi satu `bytea`, supaya panjang yang salah mustahil ditulis diam-diam.

`key_version` bukan hiasan. Ticket 10 mengunci **rotate ≠ revoke-as-compromised**: rotasi tidak boleh mengganggu Run yang berjalan, karena rotasi yang membunuh Run membuat orang berhenti merotasi. Tanpa kolom versi, rotasi master key harus mengenkripsi ulang seluruh tabel dalam satu transaksi — yang berarti ia bisa gagal di tengah dan meninggalkan tabel yang separuhnya tak terbaca. Dengan `key_version`, file kunci memegang beberapa versi dan rotasi jadi **inkremental serta bisa diinterupsi**.

AAD = id secret + id Principal pemilik berarti baris yang disalin ke Principal lain gagal didekripsi — invarian ticket 10 ditegakkan kriptografis, bukan oleh `WHERE`.

### Retensi: penanda `*_purged_at` dengan partial index

Empat kebijakan (Artifact 90 hari, Branch, Session, Log 30 hari) dipicu state Postgres — ticket 15 menolak lifecycle rule bucket justru untuk itu.

Satu pola untuk keempatnya: **kolom penanda nullable pada baris pemiliknya** (`artifacts_purged_at`, `branches_purged_at`, `logs_purged_at` di `runs`; `session_purged_at` di `step_runs`), dengan partial index `(ended_at) WHERE <penanda> IS NULL`.

Ini memberi tiga hal sekaligus: sweep jadi indexed scan yang **menyusut sambil bekerja** alih-alih memindai ulang seluruh sejarah, sweep jadi **idempoten** (aturan map: operasi terjadwal harus aman dijalankan ulang), dan "sudah direklamasi" jadi fakta yang tercatat alih-alih disimpulkan dari ketiadaan.

Jam retensi log dibaca **sejak Run berakhir**, sama dengan tiga lainnya — ticket 18 tidak menyebut titik mulainya, dan satu jam untuk keempatnya adalah bacaan yang koheren.

### Dedup: tiga constraint, dan satu yang hampir salah

- **Chunk log** — `log_chunks(step_run_id, attempt, seq, byte_offset, size)`, primary key `(step_run_id, attempt, seq)`, POST ulang jadi `ON CONFLICT DO NOTHING`. Ini yang dimaksud ticket 18 dengan "dedup di primary key, bukan di kode". Tabelnya wajib ada karena control plane harus bisa menjawab "daftar presigned GET dari offset N" tanpa memegang byte.
- **Delivery webhook** — `webhook_deliveries(delivery_id PK, received_at)`, dibersihkan sweep 24 jam dengan pola penanda yang sama.
- **Kunci natural (Pipeline, SHA)** — dan di sinilah hampir terjadi kesalahan. Unique index polos atas `(pipeline_repository_id, pipeline_path, commit_sha)` akan **melarang rewind**, karena ticket 06 mengunci rewind sebagai Run baru ber-`parent_run_id` atas commit yang sama, dan ticket 22 juga menyediakan pemicu manual lewat tombol UI. Yang benar adalah **partial unique index**: berlaku hanya saat `trigger_kind = 'automation' AND parent_run_id IS NULL`. Aturan "satu Run per commit" ticket 22 memang selalu soal Automation — teksnya jelas, tapi constraint yang ditulis harfiah akan menabrak dua fitur lain.

### Cache definisi: fill-on-miss adalah yang membuat kedua sifatnya benar

Ticket 08 menyebutnya turunan murni yang boleh dihapus kapan saja; ticket 22 menjadikannya **wajib**. Keduanya tetap benar asal ada satu hal: **jalur pengisian sinkron saat miss.** Webhook datang, cache kosong, control plane menembak GitHub saat itu juga lalu mengisi. Tanpa jalur itu "boleh dihapus" adalah kebohongan.

`pipeline_definition_cache(repository_id, path, ref, content_sha, parsed, fetched_at)`, diperbarui di latar saat push ke default branch, **tidak pernah dibaca jalur eksekusi** — eksekusi membaca snapshot di `runs`.

### Snapshot definisi: inline di Postgres, dan pengecualian terhadap ticket 15 dinyatakan

Ticket 15 mengunci semua artefak ke blob tanpa jalur inline Postgres, dengan alasan ambang ukuran akan menggandakan jalur penghapusan. Snapshot definisi **bukan** Artifact: ia tidak dihasilkan StepRun untuk dibaca manusia, dan **jalur eksekusi membacanya** — materialisasi Graph dan teks prompt tiap Step. Menaruhnya di blob berarti tiap klaim StepRun menembak Garage.

Dipilih: `runs.definition` (jsonb tervalidasi) dan `runs.definition_files` (path → isi, termasuk file prompt ticket 08), keduanya inline. Ia juga harus hidup **persis selama baris Run**, yang menurut ticket 20 tidak pernah kedaluwarsa — blob dengan jam retensi berbeda adalah risiko rujukan menggantung.

Batas ukuran ditegakkan **saat validasi definisi**, supaya satu repo dengan file prompt raksasa tidak membengkakkan `runs`.

### Tabel

Tidak ada tabel `pipelines`. Ticket 08 mengunci identitas Pipeline sebagai repo tuan rumah + path, tanpa id dan tanpa pendaftaran — jadi ia pasangan kolom di `runs` dan di cache, bukan baris.

`principals(id, kind)` ada sebagai tabel sendiri, dengan `users(principal_id PK, ...)` dan `service_accounts(principal_id PK, project_id, ...)` menunjuk padanya. Ini yang membuat "credential menempel ke Principal" (ticket 05/10) jadi foreign key tunggal alih-alih sepasang kolom nullable yang saling meniadakan.

Webhook notifikasi ticket 19 adalah **kolom di `projects`**, bukan tabel — "satu outgoing webhook per Project" berarti tidak ada kardinalitas untuk dimodelkan.

```
principals · users · service_accounts · org_members · projects · project_members
groups · group_members · repositories · pats · secrets
github_app_installations · audit_log
runs · step_runs · step_run_costs · questions · artifacts · log_chunks
runners · runner_join_tokens
webhook_deliveries · pipeline_definition_cache
```

Partial unique index kedua yang benar-benar diperlukan: **satu Question terbuka per StepRun** — `UNIQUE (step_run_id) WHERE answered_at IS NULL`. Ticket 14 mengunci Question sebagai satu-satunya titik commit sebuah giliran, jadi dua Question terbuka untuk satu StepRun adalah keadaan yang tidak boleh bisa ditulis.

### Yang belum diuji

User AFK setelah pertanyaan ketujuh. Tujuh keputusan pertama diuji hidup dan dibantah di beberapa titik (tiga dari empat rekomendasi awal terbalik). **Enam keputusan setelahnya — biaya, secret, retensi, dedup, cache definisi, dan snapshot definisi — diambil agent sendirian dan belum pernah dibantah siapa pun.** Keenamnya konsekuensi dari keputusan yang sudah dikunci ticket lain dan tidak satu pun membuka arah baru, tapi tidak satu pun juga sudah melewati orang kedua. Sesi berikutnya yang menyentuh salah satunya sebaiknya membacanya sebagai rekomendasi kuat, bukan sebagai keputusan yang sudah diadu.
