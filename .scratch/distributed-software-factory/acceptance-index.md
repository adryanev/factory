# Acceptance Criteria Index

## Issue 2 — Scaffold monorepo, database, dan rig test seam-1

**Blocked by:** None

**Files/areas touched:** monorepo pnpm (shared, control-plane, runner, web), Drizzle, id generator, OpenAPI generator, CI

**Acceptance criteria:**

- [ ] `pnpm test` menjalankan test yang menembak endpoint HTTP di atas Postgres kontainer sekali pakai dengan migrasi Drizzle dijalankan apa adanya
- [ ] Helper id membangkitkan UUIDv7 base32 berprefiks tipe di klien, terurut waktu, dan aman sebagai komponen ref git
- [ ] Bentuk error `{ code, message }` dan aturan "tidak ada credential di path maupun query string" berlaku di seluruh permukaan
- [ ] Dokumen OpenAPI dibangkitkan dari Zod, di-commit, dan CI merah bila hasil generator berbeda dari yang tersimpan
- [ ] Jam, jaringan, dan seed acak diinjeksikan — tidak ada test yang membacanya dari lingkungan
- [ ] Gerbang hash migrasi di boot: control plane menolak start dengan pesan jelas bila skema tidak cocok

---

## Issue 3 — Auth, Project, keanggotaan, Group, dan audit log

**Blocked by:** #2

**Files/areas touched:** principals table, users, service_accounts, Project, peran, Group, audit_log

**Acceptance criteria:**

- [ ] Login GitHub OAuth menghasilkan cookie `httpOnly` `Secure` `SameSite=Lax` dengan baris sesi di Postgres; identitas GitHub tidak pernah dipakai untuk otorisasi
- [ ] Break-glass lokal punya form password di route terpisah dan menghasilkan cookie yang sama persis; hanya `audit_log` yang membedakan
- [ ] `401` belum login · `403` login tapi tidak boleh dengan badan menyebut project dan sebabnya · `404` benar-benar tidak ada
- [ ] Owner org yang ditolak melihat tawaran menambahkan dirinya jadi anggota, dengan peringatan bahwa tindakan itu tercatat
- [ ] Group hanya bisa memuat anggota Project yang sama — ditolak di lapisan domain, bukan di UI
- [ ] `audit_log` append-only ditegakkan trigger `BEFORE UPDATE OR DELETE` yang `RAISE EXCEPTION`; test membuktikan UPDATE dan DELETE gagal
- [ ] Nilai secret tidak pernah masuk `audit_log`
- [ ] CSRF ditutup `SameSite=Lax` + kewajiban header yang memicu preflight; nol token, nol tabel

**Deviasi tercatat.** Tiga hal ditandai agent dan belum pernah diadu siapa pun:

1. **Break-glass sekaligus diberi `owner` org saat bootstrap.** Perlu — harus ada owner
   pertama supaya ada yang bisa menambahkan orang lain — tapi spec tidak pernah
   menyebutnya. Alternatifnya seed terpisah atau SQL manual.
2. **Tidak ada endpoint untuk mengangkat `owner` org kedua.** Hari ini satu-satunya jalan
   adalah SQL langsung ke database. Bukan bagian kriteria issue ini, tapi deployment nyata
   menabraknya.
3. **Tawaran self-add untuk owner org ada di level API, tanpa layar.** `403` membawa
   `code: forbidden_not_project_member_org_owner` dan menunjuk endpointnya. `packages/web`
   belum punya routing sama sekali, jadi layarnya menunggu #14.

**Penyimpangan dari ticket 11 yang justru perbaikan, bukan kemunduran.** Ticket 11 menulis
"keanggotaan awal diverifikasi dari org GitHub". Yang dibangun: login GitHub selalu
mengautentikasi lalu melahirkan Principal dorman tanpa akses apa pun, dan keanggotaan
diberikan eksplisit sesudahnya. Ini lebih patuh pada garis spec "identitas GitHub hanya
menjawab siapa kamu, tidak pernah boleh apa" ketimbang mengecek org GitHub secara live —
pengecekan live akan mengembalikan otorisasi ke GitHub, persis yang spec tolak.

---

## Issue 4 — Definisi Pipeline, pemicu manual, dan materialisasi Graph

**Blocked by:** #3

**Files/areas touched:** Pipeline YAML, definisi file, validasi Zod, materialisasi Graph, runs table

**Acceptance criteria:**

- [ ] Identitas Pipeline adalah repo tuan rumah + path file — tidak ada tabel `pipelines`, tidak ada pendaftaran
- [ ] Definisi dibaca dari ref yang dipicu, bukan dari default branch
- [ ] Setiap klausa XOR ditegakkan skema Zod dengan pesan yang menunjuk baris: `branches:`/`branchesFrom:`, `agent:|prompt:|promptFile:`/`run:`, `prompt:`/`promptFile:`; `after:` menunjuk id yang ada dan Graph-nya asiklik
- [ ] `outputs:` ditolak pada Step `run:`; `timeout:`/`attempts:` ditolak pada Step ber-`kind:`
- [ ] File prototype yang ada dipakai sebagai fixture dan tetap lolos validasi
- [ ] `runs.definition` dan `runs.definition_files` disimpan inline di Postgres; batas ukuran ditegakkan saat validasi
- [ ] Materialisasi Graph terjadi dalam satu transaksi Postgres
- [ ] Halaman daftar Run memakai paginasi keyset dengan `id` sebagai cursor, tanpa total count; filter `ended_at IS NULL` dan `outcome = …` terpisah tegas
- [ ] Id Run dibangkitkan klien, sehingga klik ganda tombol pemicu ditolak primary key

**Deviasi tercatat — dibaca saat #4 direview formal.** Validator dan compiler kontrak
Output sudah ditulis lebih awal di `packages/shared/src/pipeline/` (50 test hijau), tetapi
dua hal menyimpang dari bunyi kriteria dan tidak boleh hilang diam-diam:

1. Kriteria "file prototype yang ada dipakai sebagai fixture dan tetap lolos validasi"
   **tidak terpenuhi harfiah**. `d-verdict/01-fanout-review.yaml` — prototype pemenang —
   ditolak validator karena ia punya `ask:` tanpa `concurrency:`, sementara spec
   ("Automation") mewajibkan Pipeline ber-`ask:` menulis `concurrency:` eksplisit.
   Prototype itu lebih tua dari aturannya. Salinan di `__fixtures__` di-patch dengan
   `concurrency: cancel` dan patch-nya ditulis di kepala file. Keputusannya benar —
   spec menang atas prototype yang mendahuluinya — tapi artinya kriteria ini lulus atas
   fixture yang disunting, bukan atas file prototype apa adanya.
2. Fixture adalah **salinan**, bukan pembacaan langsung dari
   `.scratch/.../prototypes/pipeline-format/`. Disengaja: README prototype menyatakan
   dirinya "sekali pakai, jangan dipelihara", jadi suite test tidak digantungkan padanya.
   Konsekuensinya salinan bisa hanyut dari aslinya tanpa ada yang merah.

---

## Issue 5 — Protokol Runner: join, claim, heartbeat, lease

**Blocked by:** #4

**Files/areas touched:** Runner endpoints, /join /claim /heartbeat, kueri klaim SQL, sweep, lease, capabilities

**Acceptance criteria:**

- [ ] Join token sekali pakai ditukar jadi runner-id + secret di disk; identitas ada di file itu, bukan di hostname atau IP
- [ ] Kapabilitas diprobe tiap start (exec mode, agent CLI terpasang, cpu/ram); `slots` dan label ditulis operator; hash-nya ikut heartbeat dan laporan penuh diminta saat berubah
- [ ] `/claim` long-poll dengan durasi tahan **diacak server 20–30 detik**; test membuktikan kolam yang datang bersamaan pecah dalam satu siklus
- [ ] Kueri klaim ditulis SQL tangan dengan `FOR UPDATE SKIP LOCKED`, containment tag, `count(*) < $slots` sebagai pagar, dan `ORDER BY ready_at`; punya contract test langsung ke Postgres di bawah klaim serentak
- [ ] Lease 30 detik diperbarui heartbeat 10 detik; lease hilang → sweep → dijadwalkan ulang sebagai attempt baru dengan `reason` tercatat terpisah
- [ ] Sweep dijalankan sebelum listener dibuka saat startup
- [ ] `unknown_leases` di balasan heartbeat terpisah dari `cancel` — test membuktikan operator bisa membedakan "dibatalkan orang" dari "kehilangan lease"
- [ ] `/heartbeat` **selalu** diterima walau protokol di luar rentang; `/claim` menjawab **`426`**, dan UI menampilkan sebabnya
- [ ] Hanya `401` yang membuat Runner berhenti; `426`/`409`/`400`/`413`/`429`/`503`/`5xx` semuanya membiarkan ia tetap heartbeat dan kembali ke `/claim`
- [ ] Cancel otoritatif di control plane: baris jadi `cancelled` seketika dan UI berubah; `/result` yang telanjur dikirim dijawab `409`
- [ ] Idempotensi `/result` bersandar pada `lease_token` — sama menjawab `200` dengan hasil tercatat, berbeda menjawab `409`
- [ ] Drain dan revoke lewat satu kolom `desired_state`, ditulis CLI lokal maupun tombol UI; revoke adalah fencing, bukan pembunuhan
- [ ] Batas 2000 koneksi menggantung per instance, di atasnya `503` + `Retry-After`

---

## Issue 6 — Git sebagai bus, Step run:, dan GitHost

**Blocked by:** #5

**Files/areas touched:** Provider Docker/host, sandcastle, GitHost interface, installation token, git push/fetch, branch naming

**Acceptance criteria:**

- [ ] Provider Docker bawaan sandcastle dipakai apa adanya; provider host ditulis sendiri dan didaftarkan `tag: "bind-mount"` — `tag: "none"` mematikan session capture secara senyap
- [ ] Titik commit satu giliran: `push branch → unggah blob → POST /result`, melahirkan invarian **StepRun `succeeded` ada ⇒ ref ada**
- [ ] Giliran yang gagal memakai endpoint yang sama dengan `outcome: failed` + `reason`, dan `ref` opsional bila branch sempat terdorong
- [ ] Installation token di-mint **dua kali per giliran** (sebelum fetch dan sebelum push), umur 1 jam, `repository_ids` sempit, `contents:write` saja, dihapus saat teardown
- [ ] Sandbox tidak pernah melewati `contents:write`
- [ ] Cancel dibangun di luar sandcastle: docker lewat network per-StepRun → stop dengan grace 30 detik; host lewat sinyal ke process group; test membuktikan proses anak ikut mati
- [ ] Jam wall-clock hanya satu dan dipegang control plane; jam idle/completion sandcastle dibiarkan karena ia mengukur agent menggantung, bukan wall-clock
- [ ] `runsOn: [exec:host]` hanya jalan bila Project punya izinnya; `exec:docker` adalah bawaan
- [ ] Contract test terhadap sandcastle sungguhan atas tiga perilaku internal yang patah senyap: gerbang session capture, path worktree verbatim, idle timer yang di-reset tiap output
- [ ] Versi sandcastle di-pin eksak, dan seluruh pemakaiannya hanya lewat direktori `agent-runtime`

---

## Issue 7 — Log: Garage, chunk, dan live-tail

**Blocked by:** #6

**Files/areas touched:** Garage object store, log chunks, live-tail endpoint, presigned URLs, ring buffer

**Acceptance criteria:**

- [ ] Garage berjalan dengan versi di-pin eksak dan hostname sendiri; CORS di bucket: `GET` untuk browser, `PUT` untuk Runner
- [ ] Runner flush tiap 1 detik atau 256 KiB; control plane hanya mencatat metadata chunk, tidak pernah menerima byte
- [ ] Kunci (StepRun, attempt); dedup di primary key `(step_run_id, attempt, seq)` dengan `ON CONFLICT DO NOTHING` — bukan di kode
- [ ] Live-tail memakai bentuk long-poll yang sama dengan `/claim` dan mengembalikan daftar presigned GET; arsip memakai endpoint yang sama dari offset nol
- [ ] Ring buffer 64 MiB membuang yang **tertua** dan menghasilkan satu chunk bermarker; batas 256 MiB **memotong tanpa menggagalkan StepRun** dan menghasilkan chunk bermarker berbeda — test membuktikan keduanya tidak tertukar
- [ ] Log attempt yang mati tidak ditimpa attempt berikutnya
- [ ] Redaksi literal best-effort sebelum upload, sama persis dengan redaksi Artifact dan tidak lebih luas; didokumentasikan sebagai **bukan** kontrol keamanan
- [ ] Presigned GET berumur 5 menit; dokumentasi menyatakan pencabutan bukan penarikan kembali
- [ ] Satu tab browser = satu koneksi menggantung; SSE dan WebSocket ditolak karena Runner flush 1 detik sehingga data lebih segar memang tidak ada

---

## Issue 8 — Secret dan credential

**Blocked by:** #6

**Files/areas touched:** Secret table, AES-256-GCM enkripsi, key rotation, ServiceAccount, fallback User, egress control

**Acceptance criteria:**

- [ ] AES-256-GCM dengan **AAD = id secret + id Principal pemilik**; test membuktikan baris yang disalin ke Principal lain gagal didekripsi — invarian kriptografis, bukan klausa `WHERE`
- [ ] `nonce` dan `auth_tag` kolom terpisah, bukan disambung, supaya panjang yang salah mustahil ditulis diam-diam
- [ ] `key_version` per baris membuat rotasi master key **inkremental dan bisa diinterupsi**; rotasi tidak pernah mengganggu Run yang berjalan
- [ ] Fallback User→ServiceAccount lewat `allowSharedAgentCredential`, bawaan **mati**, dan pemakaiannya terlihat lewat dua kolom atribusi terpisah di `runs`
- [ ] Secret ikut di muatan `/claim` dan diserahkan langsung ke pemanggilan agent — tidak pernah ditulis ke file di dalam sandbox
- [ ] Default-deny egress dari Sandbox; allowlist per Project masuk daftar audit
- [ ] Di `exec:host`, agent berjalan sebagai user OS terpisah dari proses Runner; test membuktikan user itu tidak bisa membaca file secret Runner
- [ ] Lima hal yang sengaja tidak dilindungi ditulis eksplisit di dokumentasi keamanan

---

## Issue 9 — Step ber-agent: sandcastle dan kontrak Output

**Blocked by:** #7, #8

**Files/areas touched:** agent-runtime, Output XML tag, skema Output (type mini language), instruction block generation, validator

**Acceptance criteria:**

- [ ] Bahasa tipe mini dua tingkat dengan batas keras: skalar `string|number|boolean`, `array` ber-`items` skalar atau objek datar tanpa sarang, semua field wajib, `description:` opsional
- [ ] Key dideklarasikan tipe berkendala `[a-z0-9][a-z0-9._-]{0,63}` sehingga agent memperbaiki dirinya di dalam giliran
- [ ] Step dengan `ask:` **selalu** mendapat definisi output walau `outputs:`-nya kosong
- [ ] Blok instruksi dibangkitkan **Runner** dari `outputs:` dan ditempelkan ke prompt; nama tag adalah konstanta sistem yang tidak pernah diketik siapa pun
- [ ] UI menampilkan **prompt final yang dikirim**, bukan hanya isi file aslinya
- [ ] Validasi di dua tempat dari **satu** skema: Runner untuk umpan balik (satu-satunya tempat session masih hidup), control plane sebagai gerbang otoritatif
- [ ] Output ditolak → StepRun `failed` dengan `reason: output-invalid`, memakan `attempt` biasa; branch yang telanjur ada jadi yatim untuk GC
- [ ] `maxRetries` **tidak ditulis di YAML** — Runner menurunkannya dari kapabilitas agent (bisa resume → 2, tidak bisa → 0), karena pemanggilan gagal di pintu masuk bila keduanya tidak cocok
- [ ] `branchesFrom` diperiksa saat validasi definisi: Step sumber wajib punya `outputs:` bertipe array of object yang memuat `key: string`

---

## Issue 10 — Artifact

**Blocked by:** #7, #9

**Files/areas touched:** Artifact table, immutable storage, uploads endpoint, metadata, blob presigned URLs, diff materialization

**Acceptance criteria:**

- [ ] Artifact **immutable, satu per StepRun, tanpa tabel versi**; "riwayat" adalah kueri per key diurutkan menurut turn
- [ ] `/uploads` diminta **sekali per (StepRun, attempt)** sebagai satu batch berisi seluruh artefak plus session; permintaan ulang **mengganti** grant sebelumnya, bukan menambah
- [ ] Kuota 1 GiB per artefak dan 5 GiB per StepRun ditolak **saat URL diminta**, bukan setelah byte naik; test membuktikan kuota tidak bisa hanyut lewat permintaan berulang
- [ ] Upload dulu → catat metadata, dengan metadata **menumpang `POST /result`**; invarian *baris Artifact ada ⇒ blob pasti ada*
- [ ] Artefak yang gagal naik permanen tidak masuk daftar, dan StepRun tetap sukses
- [ ] Diff dimaterialisasi jadi blob saat StepRun berakhir, sehingga branch bebas dihapus
- [ ] Semua ke blob tanpa jalur inline Postgres; snapshot definisi adalah pengecualian yang sudah dinyatakan, bukan preseden
- [ ] `key` dinormalisasi slug — keunikan memang tidak pernah dijanjikan di sini, berbeda dari Key fan-out
- [ ] Baca artefak memakai izin Project; owner org tidak otomatis

---

## Issue 11 — Fan-out dan Join

**Blocked by:** #9

**Files/areas touched:** branches/branchesFrom, Key, unique constraint, fan-out materialization, Join policy, manifest JSON

**Acceptance criteria:**

- [ ] Satu jalur fan-out saja: `branches:` konstanta atau `branchesFrom:` dari Output hulu — tidak ada `parallelism: N`
- [ ] Key ditulis eksplisit per elemen; duplikat menggagalkan Run saat fan-out, ditegakkan **struktural** oleh unique `(run_id, step_key, branch_key, turn)` dengan `NULLS NOT DISTINCT`
- [ ] `branch_key` NULL untuk Step non-fan-out — NULL berarti apa adanya; sentinel string kosong ditolak
- [ ] Normalisasi slug **tidak** dipakai untuk Key: test membuktikan `Frontend` dan `frontend` tertangkap sebagai duplikat, bukan lolos lalu bertabrakan di remote
- [ ] Materialisasi hibrida: Step non-fan-out di muka, cabang saat hulu sukses, keduanya dalam satu transaksi
- [ ] Kebijakan `all` (bawaan) / `any` / `min: N` dimiliki Join; `minBranches` bawaan 1 menutup jebakan "`all` atas himpunan kosong bernilai benar"
- [ ] Join menerima **manifest JSON** `[{ key, repo, branch, sha, outcome, outputs }]` dan fetch repo tuan rumahnya sendiri saja — yang lintas repo adalah bacaannya, bukan checkout-nya
- [ ] Join di hilir fan-out ber-repo **wajib** menulis `repo:` eksplisit; ketiadaannya adalah error validasi
- [ ] Cabang `awaiting-human` tidak menahan cabang lain; Join `all` boleh menggantung selamanya
- [ ] `runs.outcome` dan `runs.ended_at` nullable dan **ditulis sekali** oleh transaksi yang mengakhiri Run; jalur penjadwalan tidak pernah membacanya
- [ ] `skipped` menyebar ke hilir dan berbeda dari `failed` baik di data maupun di tampilan

---

## Issue 12 — Cost dan token tracking

**Blocked by:** #9

**Files/areas touched:** step_run_costs table, price_version, aggregation endpoints, cost UI display, audit columns

**Acceptance criteria:**

- [ ] Estimasi dilarang: agent yang tidak melaporkan pemakaian menampilkan "tidak didukung", bukan angka perkiraan
- [ ] UI menyatakan total Project sebagai batas bawah, dengan kata-kata, bukan lewat tanda kecil
- [ ] Biaya dihitung **sekali** saat StepRun berakhir dan disimpan bersama `price_version`; tidak ada tampilan yang mengalikan ulang saat tabel harga berubah
- [ ] Tabel biaya **insert-only, satu baris per attempt**, dengan `(step_run_id, attempt)` sebagai primary key; retry tidak menulis ke sana sama sekali
- [ ] "Kumulatif lintas attempt" adalah penjumlahan biasa — tidak ada kolom yang perlu sengaja tidak disentuh saat retry
- [ ] Biaya per attempt terlihat, yang berguna persis saat menyelidiki StepRun yang gagal berulang
- [ ] Tiga agregasi di endpoint terpisah yang **tidak** menumpang poll 3 detik
- [ ] Biaya berjalan tampil selagi Run berjalan, di layar yang sudah memuat tombol cancel
- [ ] Dua kolom atribusi terpisah, sehingga pemakaian credential bersama terlihat
- [ ] Retensi: tidak pernah kedaluwarsa, seumur baris Run
- [ ] Dokumentasi menyatakan telanjang bahwa tidak ada kuota: satu Run liar bisa membakar kredit sampai habis dan sistem tidak akan menghentikannya

---

## Issue 13 — Step human-in-the-loop

**Blocked by:** #7, #9

**Files/areas touched:** awaiting-human status, session blob storage, Question/Answer types, group management, unique Question index

**Acceptance criteria:**

- [ ] `awaiting-human` melepas lease dan slot; test membuktikan Runner boleh di-drain dan dimatikan selagi percakapan menggantung, lalu giliran berikutnya diklaim mesin **lain**
- [ ] Session diangkut lewat blob store dengan implementasi `AgentSessionStorage` sendiri; ini konsumen ketiga blob setelah log dan Artifact
- [ ] Dua penomoran terpisah: giliran melahirkan baris StepRun baru, `attempt` menghitung ulang di dalamnya, dan retry policy membaca `attempt` saja
- [ ] Bentuk Question dan Answer tertutup di skema Zod `shared`, dipakai ketiga komponen:

```ts
type Question =
  | { kind: "text";     body: string }
  | { kind: "choice";   body: string;
      options: { id: string; label: string; description?: string }[];
      multi: boolean; allowOther: boolean }
  | { kind: "approval"; body: string }
```

- [ ] `approved: false` **tidak** menggagalkan apa pun dengan sendirinya — ia dikirim balik ke agent sebagai prompt giliran berikutnya; akibat ke Graph ditulis sebagai `onReject: fail | continue`
- [ ] Question ditujukan ke Group, jawaban pertama menang lewat compare-and-set, penjawab selalu dicatat
- [ ] Partial unique index menegakkan **satu Question terbuka per StepRun**
- [ ] Kalah balapan adalah **keadaan, bukan error**: `409` membawa Question terbaru beserta penjawabnya, dan ketikan yang telanjur ditulis tidak dibuang
- [ ] Tanpa kadaluarsa bawaan; `humanTimeout:` opsional dan `onHumanTimeout:` hanya bermakna bila ia bukan `none`
- [ ] Cancel saat `awaiting-human` adalah murni penulisan baris DB — tidak ada endpoint Runner yang terlibat
- [ ] Pipeline ber-`ask:` **wajib** menulis `concurrency:` eksplisit; ketiadaannya adalah error validasi

---

## Issue 14 — UI monitoring Run

**Blocked by:** #7, #11

**Files/areas touched:** Graph visualization, panel layout, status styling, log tabs, banners, ETag polling

**Acceptance criteria:**

- [ ] Graph adalah tampilan bawaan halaman Run
- [ ] Kotak fan-out **meringkas di atas delapan cabang**, diurutkan `failed` → `awaiting` → `unsched` → `running`; peringkasan menurut Key ditolak karena ia menyembunyikan satu-satunya cabang gagal
- [ ] Panel kanan **tetap** ⇒ tidak ada URL per StepRun, dan itu dinyatakan di dokumentasi
- [ ] Status berbentuk, bukan sekadar titik berwarna: `skipped` dan `failed` harus bisa dibedakan tanpa membandingkan rona
- [ ] Log **per cabang** dengan tab sendiri; aliran gabungan ditolak karena urutan lintas cabang hanya sebenar jam tiga mesin berbeda
- [ ] Banner sumbatan hanya untuk yang **menahan** Run; cabang `failed` di bawah Join `any` sengaja tidak naik
- [ ] Notasi giliran ditulis panjang (`giliran 4 · attempt 1`) di mana-mana kecuali di nama branch, di mana ia literal dan disalin ke `git checkout`
- [ ] StepRun yang tidak terjadwal lebih dari 5 menit ditandai — antre tidak boleh terlihat sama dengan macet
- [ ] Poll 3 detik + ETag, dengan `304` tanpa badan saat Run tidak bergerak
- [ ] Cancel mengembalikan `cancel_requested_at` sebagai **niat**, dan layar mengakuinya seketika sementara mekanik berjalan di belakang
- [ ] Token visual memakai design system organisasi; `--attention` hanya berarti "ditulis manusia ke dalam artefak"

---

## Issue 15 — Layar grilling dan edit-artifact

**Blocked by:** #10, #13

**Files/areas touched:** grilling UI layout, artifact editing, conversation display, summary view, rewind

**Acceptance criteria:**

- [ ] Percakapan dan draf berdampingan di desktop; bertumpuk hanya di layar sempit
- [ ] Kotak teks **tidak pernah hilang** — `choice` berarti *choice dengan teks*, bukan menggantikannya
- [ ] Sunting langsung di draf, ditandai `--attention` sebagai tulisan manusia; riwayatnya gratis karena Artifact immutable per StepRun
- [ ] `kind: edit-artifact` ditambahkan ke daftar Question/Answer — aditif, tanpa keputusan model data baru
- [ ] Draf hanya bisa disunting oleh pemegang giliran menjawab; yang lain melihatnya read-only. Nol mekanisme penguncian kedua
- [ ] Ringkasan "selagi kamu pergi" saat sesi dibuka kembali, keempat angkanya kueri murni
- [ ] Tab Keputusan, dengan daftar keputusan dibangkitkan agent sebagai bagian Output
- [ ] Rewind dipasang sebagai Run baru ber-`parent_run_id`
- [ ] **Tanpa tombol "Selesai"** — ia akan mendarat persis di sebelah Batalkan Run

---

## Issue 16 — Notifikasi dan lencana

**Blocked by:** #13

**Files/areas touched:** notification badge query, webhook_deliveries table, project webhook configuration, digest schedule

**Acceptance criteria:**

- [ ] Lencana adalah kueri atas partial index `questions (created_at) WHERE answered_at IS NULL`, bukan tabel yang di-maintain
- [ ] Lencana **menumpang** respons poll Graph dan long-poll log — nol endpoint dan nol interval sendiri; tab yang tidak membuka Run memakai satu poll lambat
- [ ] Halaman "Menunggu saya" diurutkan umur
- [ ] Satu outgoing webhook per Project sebagai **kolom di tabel Project**, bukan tabel tersendiri
- [ ] Dua jenis kejadian: Question terbit, dan **Run gagal** — yang kedua wajib karena Automation berjalan sebagai ServiceAccount dan tidak punya manusia untuk diberi tahu
- [ ] Fan-out 50 cabang menghasilkan **satu** pesan lewat coalescing 60 detik di sweep yang sudah ada
- [ ] Notifikasi ke channel, bukan orang — tidak ada kanal per-orang yang bisa membanjir
- [ ] Tanpa pengingat per-Question dan tanpa preferensi per-User; umur yang terlihat menggantikan timer
- [ ] Digest harian per Project adalah satu-satunya timer, dan ia membaca state sehingga aman dijalankan ulang

---

## Issue 17 — Step kind: pull-request dan Commit Status

**Blocked by:** #6, #11

**Files/areas touched:** pull-request step type, lease execution, Commit Status API, PR creation/adoption logic

**Acceptance criteria:**

- [ ] Eksekusi memakai ulang **kueri lease yang sama** dengan Runner, dengan lessee berupa instance control plane, lease 60 detik tanpa heartbeat, dan sweep yang sudah ada memungut yang menggantung
- [ ] Angka milik jenisnya, bukan penulis: `timeout: 60s`, `attempts: 3`, patuhi `Retry-After`; `timeout:`/`attempts:` ditolak skema pada Step ber-`kind:`
- [ ] Lahir sekali per cabang bila tanpa `join:`; `repo:` tidak ditulis dan tidak boleh ditulis — ia mewarisi repo cabangnya
- [ ] `kind: pull-request` adalah **daun**: `after:` yang menunjuknya adalah error validasi
- [ ] Rujukan `{ title, body }` eksplisit ke Step + nama Output; tersirat-dari-`after:` ditolak karena ia ambigu pada Join
- [ ] Idempotensi bersandar ke GitHub: cari PR yang cocok lalu adopsi, dan 422 diperlakukan sukses. Batasnya didokumentasikan — PR yang sudah ditutup manusia menghasilkan PR baru, dan itu benar
- [ ] Status ke commit lewat **Commit Status API** dengan `details_url` ke halaman Run; Checks API ditolak
- [ ] Permukaan tulis berhenti di dua izin: nol komentar, nol label, nol tulisan ke issue, **nol merge**
- [ ] Cancel diperiksa tepat sebelum panggilan tulis; sisa jendela milidetik dinyatakan di dokumentasi

---

## Issue 18 — Automation: webhook, cron, dedup, concurrency

**Blocked by:** #17

**Files/areas touched:** on: trigger configuration, webhook endpoint, cron scheduler, pipeline_definition_cache, dedup logic

**Acceptance criteria:**

- [ ] `on:` di file definisi memetakan dua himpunan: Pipeline bertuan-rumah repo X dibaca dari ref yang dipicu; Pipeline lintas repo di repo config dibaca dari default branch-nya
- [ ] Cache definisi jadi **wajib** dengan **jalur pengisian sinkron saat miss** — tanpa itu "boleh dihapus kapan saja" adalah kebohongan; cache tidak pernah dibaca jalur eksekusi
- [ ] PR dari fork diabaikan seluruhnya
- [ ] Dedup dua lapis: id delivery selama 24 jam, lalu kunci natural (Pipeline, SHA)
- [ ] Kunci natural memakai **partial** unique index yang berlaku hanya saat pemicunya automation dan bukan rewind — test membuktikan rewind dan pemicu manual tetap bisa jalan atas commit yang sama
- [ ] Concurrency bawaan `cancel`
- [ ] Cron: skip saat tumpang tindih, dan pelewatannya terlihat di UI; jadwal baru hidup hanya setelah merge
- [ ] Branch dihapus atau PR ditutup ⇒ cancel, **termasuk** yang `awaiting-human`
- [ ] `automation_enabled` per Project dengan izin `admin`, dan perubahannya masuk audit
- [ ] Trigger dari komentar GitHub **tidak** dibangun; pemicu manual tetap lewat tombol UI

**Catatan skema — jangan "diperbaiki" tanpa membaca ini.** Spec ("Skema database") menyebut
*tiga* partial unique index, salah satunya "tabel dedup delivery webhook". Implementasinya
sengaja **bukan** partial index: `webhook_deliveries.delivery_id` adalah primary key biasa,
karena keunikannya global dan tanpa syarat — partial index menuntut predikat `WHERE`, dan di
sini tidak ada baris yang perlu dikecualikan. Jendela retensi 24 jam adalah urusan sweep,
bukan urusan index. Jadi yang benar-benar partial ada dua, keduanya sudah terpasang dan
terverifikasi:

- `runs_pipeline_sha_automation_dedup` — `WHERE trigger_kind = 'automation' AND parent_run_id IS NULL`
  (klausa kedua yang menjaga rewind dan pemicu manual tetap bisa jalan atas commit yang sama)
- `questions_one_open_per_step_run` — `WHERE answered_at IS NULL`

Prosa spec di sini longgar, implementasinya benar.

---

## Issue 19 — Sweep retensi

**Blocked by:** #7, #10, #13

**Files/areas touched:** retention sweep logic, *_purged_at columns, partial indexes, branch cleanup

**Acceptance criteria:**

- [ ] Empat kebijakan: Artifact 90 hari sejak Run berakhir · Log 30 hari sejak Run berakhir · Branch saat Run berakhir · Session saat StepRun tak lagi `awaiting-human` **dan** Run berakhir
- [ ] Satu pola untuk keempatnya: kolom penanda `*_purged_at` nullable pada baris pemiliknya, dengan partial index atas `ended_at` di mana penanda masih NULL
- [ ] Sweep adalah indexed scan yang **menyusut sambil bekerja**, bukan pemindaian ulang seluruh sejarah
- [ ] Sweep **idempoten** — test menjalankannya dua kali dan hasilnya sama
- [ ] Ditulis SQL tangan dengan contract test langsung ke Postgres, sesuai batas dua gaya yang sudah ditarik
- [ ] Lifecycle rule bucket tidak dipakai sama sekali
- [ ] Sweep `webhook_deliveries` 24 jam memakai pola penanda yang sama
- [ ] Branch yatim dari giliran yang mati ikut dibersihkan

---

## Issue 20 — Editor Pipeline visual

**Blocked by:** #4, #17

**Files/areas touched:** editor UI, PR generation, author/committer separation, Git Data API

**Acceptance criteria:**

- [ ] Editor menghasilkan PR ke repo tuan rumah; scope UI terkunci di situ, tanpa mode draft
- [ ] `author` = user penekan tombol lewat alamat `users.noreply.github.com`; `committer` = identitas bot
- [ ] Push memakai installation token ad-hoc, repo tuan rumah saja, dihapus setelah selesai; token OAuth per-user ditolak
- [ ] Commit dibuat lewat Git Data / Contents API, bukan clone lokal
- [ ] **Verifikasi saat implementasi**: klaim bahwa commit lewat API dengan installation token muncul sebagai `Verified` belum pernah dicek ulang
- [ ] Validasi memakai skema Zod yang sama, sebagai umpan balik awal — yang mengikat tetap control plane saat trigger
- [ ] Izin `member` cukup — turunan langsung dari penolakan peran `maintainer`
- [ ] PR yang dibuka editor **bukan** jenis kejadian audit; PR itu sendiri sudah catatan permanen ber-atribusi di GitHub

---

## Issue 21 — Packaging self-host

**Blocked by:** #18, #19

**Files/areas touched:** Docker Compose, single-node Garage, GitHub App manifest flow, configuration files, backup strategy, Runner installer

**Acceptance criteria:**

- [ ] Satu compose: control plane + web (satu image, sehingga skew web↔API mustahil secara struktural), Postgres, Garage
- [ ] Migrasi adalah servis one-shot dengan `service_completed_successfully`, sehingga jumlah migrator satu **secara konstruksi**; tetap ber-advisory-lock untuk operator yang mengetik dengan tangan
- [ ] Garage di-pin eksak dengan flag single-node; versi di bawah ambang gagal di upload pertama, bukan saat boot
- [ ] Setup GitHub App lewat **manifest flow**: manifest kita yang menentukan izinnya, dan private key tidak pernah lewat clipboard
- [ ] Konfigurasi dua tingkat: bahan kunci ke **file**, password layanan ke environment variable
- [ ] Master key di luar backup **ditegakkan lewat tata letak path**, bukan peringatan di dokumentasi
- [ ] Backup: dump database + sinkronisasi objek, bukan salin direktori data
- [ ] Runner sebagai tarball JS berprasyarat Node; installer macOS adalah skrip yang bisa dibaca
- [ ] **Verifikasi isolasi jadi gerbang menuju identitas**: join token ditukar hanya setelah terbukti user agent tidak bisa membaca file secret Runner
- [ ] Dua hostname di dokumentasi operator: satu untuk web+API, satu untuk blob; reverse proxy wajib read timeout ≥60 detik
- [ ] Dokumentasi menyatakan upgrade adalah pemadaman, dan yang lebih panjang dari satu window lease didahului `drain`
- [ ] Tidak didukung, ditulis eksplisit: Kubernetes, HA, Postgres/Garage multi-node, TLS di dalam compose, Runner Windows, rollback migrasi

---

## Summary Table

| Issue | Title | Criteria Count | Blocked by |
|-------|-------|-----------------|-----------|
| 2 | Scaffold monorepo, database, dan rig test seam-1 | 6 | — |
| 3 | Auth, Project, keanggotaan, Group, dan audit log | 8 | #2 |
| 4 | Definisi Pipeline, pemicu manual, dan materialisasi Graph | 9 | #3 |
| 5 | Protokol Runner: join, claim, heartbeat, lease | 13 | #4 |
| 6 | Git sebagai bus, Step run:, dan GitHost | 10 | #5 |
| 7 | Log: Garage, chunk, dan live-tail | 9 | #6 |
| 8 | Secret dan credential | 8 | #6 |
| 9 | Step ber-agent: sandcastle dan kontrak Output | 9 | #7, #8 |
| 10 | Artifact | 9 | #7, #9 |
| 11 | Fan-out dan Join | 11 | #9 |
| 12 | Cost dan token tracking | 11 | #9 |
| 13 | Step human-in-the-loop | 11 | #7, #9 |
| 14 | UI monitoring Run | 11 | #7, #11 |
| 15 | Layar grilling dan edit-artifact | 9 | #10, #13 |
| 16 | Notifikasi dan lencana | 9 | #13 |
| 17 | Step kind: pull-request dan Commit Status | 9 | #6, #11 |
| 18 | Automation: webhook, cron, dedup, concurrency | 10 | #17 |
| 19 | Sweep retensi | 8 | #7, #10, #13 |
| 20 | Editor Pipeline visual | 8 | #4, #17 |
| 21 | Packaging self-host | 12 | #18, #19 |
