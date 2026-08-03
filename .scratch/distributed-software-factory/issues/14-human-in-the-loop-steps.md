# Step human-in-the-loop: interaksi, suspend/resume, dan arti "hidup"

Type: grilling
Status: resolved
Blocked by: 02, 05

## Question

Sebuah step berhenti dan menunggu manusia menjawab. Apa yang terjadi pada sandbox, pada worker, pada lease, dan pada run selama penantian itu?

**Temuan dari ticket 00 yang harus diperlakukan sebagai bukti, bukan kekhawatiran**: Warren pernah mengimplementasikan HITL yang memblokir — state `paused`, kolom `paused_at`, mode run `interactive` dan `conversation` — lalu **membongkarnya**, lengkap dengan migration test khusus untuk membuang kolomnya (`drop-run-pause-columns.test.ts`, `core/wire.ts:56-62`). Ada tim yang mencoba ini di domain persis sama, lalu mundur karena tidak cocok dengan model batch-run-poll mereka. Pelajarannya: step-yang-menunggu-manusia harus dirancang ke dalam model eksekusi sejak awal, bukan ditambal di atas orkestrator yang berasumsi step berjalan sampai selesai. Sandcastle juga tidak mendukung resume sesi lintas mesin (ticket 01), jadi transportnya milik kita.

Kasus acuan: menyusun product requirement lewat grilling session di web. Agent mengajukan satu pertanyaan, manusia menjawab sepuluh menit atau tiga jam kemudian, begitu terus sampai PRD selesai. Ini menghancurkan asumsi "step dijalankan sampai selesai" yang dipakai orkestrator biasa, jadi jangan menyalin polanya begitu saja.

1. **Sandbox ditahan atau dilepas** — selama menunggu manusia, sandbox dibiarkan hidup (sederhana, tapi satu percakapan bisa menyandera slot worker seharian) atau di-suspend lalu di-resume saat jawaban datang (hemat, tapi butuh session capture/resume sandcastle bekerja lintas proses — periksa temuan ticket 01). Adakah ambang batas: tahan kalau menunggu sebentar, lepas kalau lama?
2. **Arti "hidup"** — heartbeat tidak bisa lagi berarti "sedang bekerja". Bedakan tegas antara *worker hidup*, *step sedang menghitung*, dan *step menunggu manusia*. Kalau worker mati selagi step menunggu, apa yang hilang dan apa yang bisa dipulihkan.
3. **Jalur dua arah** — pertanyaan agent harus sampai ke browser, dan jawaban manusia harus kembali ke sandbox. Padahal worker outbound-only. Apakah pertanyaan diangkat jadi entitas yang disimpan di control plane (durable, bisa dijawab kapan saja, tahan restart) atau dialirkan sebagai stream hidup (langsung, tapi hilang kalau koneksi putus)? Yang pertama jauh lebih tahan banting.
4. **Siapa yang ditanya** — sebuah step interaktif ditujukan ke siapa: pemicu run, peran tertentu, atau siapa saja yang punya akses? Bisakah dua orang menjawab pertanyaan yang sama, dan siapa yang menang.
5. **Batas waktu manusia** — kalau tidak ada yang menjawab selama dua hari, apa yang terjadi. Run gagal, tergantung selamanya, atau ada kadaluarsa? Jangan pakai timeout yang sama dengan step agent.
6. **Bertahan dari restart** — control plane di-restart selagi lima percakapan menggantung. Apa yang harus persisten supaya semuanya bisa dilanjutkan.
7. **Bentuk interaksinya** — apakah cuma tanya-jawab teks bebas, atau ada bentuk lain: pilihan ganda, persetujuan (approve/reject), suntingan atas draf artefak. Daftar tertutup akan jauh lebih mudah dibuat UI-nya dan divalidasi. Ini menyambung ke ticket 15 (kalau manusia menyunting draf, artefak itu punya versi).
8. **Cancel dan bercabang** — apa yang terjadi kalau run dibatalkan selagi menunggu. Bisakah percakapan diulang dari titik tengah tanpa mengulang dari awal.

Zoom ke ticket 02 — Temporal menyelesaikan persis masalah ini dengan durable workflow dan signal. Nilai ide itu, jangan otomatis ambil ketergantungannya.

## Answer

Model Windmill dari ticket 02 diambil utuh: **Runner benar-benar dilepas selama menunggu**. Yang membuatnya bekerja adalah satu keputusan bentuk — agent tidak pernah memblokir di dalam sandbox.

### Agent mengakhiri run-nya setiap kali bertanya

Tidak ada tool `ask_human` yang menahan, tidak ada MCP server kustom, tidak ada proses idle di mesin mana pun. Agent menutup run-nya, StepRun masuk `awaiting-human` — **baris DB tanpa lease** — Sandbox ditutup, Runner bebas. Jawaban datang, StepRun dijadwalkan ulang lewat jalur penjadwalan biasa dengan `run({resumeSession, prompt: jawaban})`. Percakapan 30 giliran = 30 kali suspend/resume.

Ini juga yang memberi arti tegas untuk "hidup", yang jadi pertanyaan tergelap ticket ini:

| | Run | lease | Sandbox |
|---|---|---|---|
| StepRun menghitung | aktif | dipegang Runner | hidup |
| StepRun menunggu manusia | aktif | **tidak ada** | **tidak ada** |

Tahan-restart datang gratis: tidak ada state percakapan di memori proses mana pun. Ini menghindari persis bentuk yang Warren bongkar — mereka menambal `paused` di atas orkestrator yang berasumsi step berjalan sampai selesai; di sini "menunggu" adalah ketiadaan lease, bukan status yang ditambahkan ke sesuatu yang sedang berjalan.

Ditolak: **menahan sandbox selama percakapan**. Menyandera slot Runner berjam-jam, Runner mati = seluruh percakapan hilang, dan menuntut MCP server sendiri karena sandcastle tidak menyediakannya. Ditolak juga **hibrida berambang waktu** — jalur "lepas" tetap wajib ada dan diuji, jadi kompleksitasnya superset dari jalur tunggal. Ambang-tahan tetap mungkin ditambahkan belakangan secara **aditif** (jalur lepas sudah jadi jalur utama); dipindahkan ke *Not yet specified* sampai prototype ticket 17 memberi angka biaya setup per giliran. Angka sekarang masih tebakan 30–60 detik, dan biayanya dibayar oleh kecepatan manusia menjawab, bukan oleh panjang percakapan: 60 detik atas jeda 3 jam tak terasa, 60 detik atas jeda 5 detik terasa rusak.

### Turn dan attempt adalah dua penomoran, bukan satu

Ticket 02 menutup dengan peringatan bahwa akar kelas bug `continueOn` Argo adalah satu bidang menjawab dua pertanyaan. Di sini dua pertanyaan itu persis ada: *sudah berapa kali gagal* dan *sudah giliran ke berapa*.

```
step_run
  turn     INT   -- giliran percakapan
  attempt  INT   -- percobaan setelah gagal

branch: run/<run-id>/<step-key>/t<turn>-a<attempt>
log:    blob append-only per (turn, attempt)
```

**Dikoreksi oleh ticket 25 — template branch ini bertabrakan pada fan-out.** Ia ditulis sebelum ticket 06 mengunci fan-out, dan tidak memuat Key. Sebuah Step yang di-fan-out 50 cabang melahirkan 50 StepRun yang berbagi `run-id`, `step-key`, `turn`, dan `attempt` — jadi kelimapuluhnya menghasilkan **nama branch yang identik dan saling menimpa di Git Remote**. `CONTEXT.md` sendiri menyatakan Key "muncul di nama Branch"; yang hilang adalah tempatnya. Bentuk yang berlaku:

```
run/<run-id>/<step-key>/<branch-key>/t<turn>-a<attempt>
run/<run-id>/<step-key>/t<turn>-a<attempt>            # Step tanpa Key
```

Karena Key untuk fan-out dinamis lahir dari Output agent dan bukan dari tangan penulis Pipeline, ia teks yang dibangkitkan model dan harus aman sebagai komponen ref git. Ticket 25 menutupnya dengan mendeklarasikan Key sebagai tipe berkendala (`[a-z0-9][a-z0-9._-]{0,63}`) di bahasa tipe mini ticket 23, sehingga agent memperbaiki dirinya di dalam giliran alih-alih menggagalkan Run.

**Retry policy membaca `attempt` saja.** Dengan satu kolom, `retry max=3` akan membunuh percakapan di giliran keempat, dan "attempt 17" tidak terbaca sebagai apa pun. Ini juga memperhalus skema penamaan branch yang ticket 02 sarankan (`<prefix>/<run-id>/<step-key>/<attempt>`).

### Session diangkut lewat blob store, Runner interchangeable

Konsekuensi yang harus dibayar dari pelepasan Runner: giliran berikutnya boleh mendarat di mesin lain, dan ticket 01 sudah menetapkan resume lintas mesin 100% pekerjaan kita (ADR 0016 membatasi resume ke file yang bisa disalin verbatim).

```
turn N    Runner-A: run() → push branch
                    readHostSession() → blob://sesi/<steprun>/t<N>
          [Runner-A bebas, boleh mati, boleh di-drain]
  ░ manusia menjawab ░
turn N+1  Runner-C: fetch branch
                    blob → hostSessionFilePath()
                    run({ resumeSession, prompt: jawaban })
```

Bentuk matangnya adalah implementasi `AgentSessionStorage` sendiri (`src/AgentProvider.ts:233-262`, interface-nya sudah diekspor) dengan backend object storage — persis yang direkomendasikan laporan ticket 01 untuk kasus "resume lintas mesin jadi fitur inti", dan itu memang yang terjadi di sini.

Ditolak: **pin StepRun ke Runner** — mengembalikan persis kerugian yang pelepasan Runner dimaksudkan menghapus; Runner tidak dilepas, ia terikat baris DB berjam-jam dan tidak bisa di-drain. Ditolak: **susun ulang prompt tiap giliran tanpa session** — murah dan agent-agnostic, tapi agent kehilangan seluruh konteks internalnya dan harus membaca ulang repo tiap giliran.

**Konsekuensi infra**: blob store kini punya tiga konsumen — log (ticket 02), Artifact (ticket 15), dan session. Catatan ticket 02 bahwa keputusan blob store bergantung ticket 15 jadi lebih berat sebelah: session sendiri sudah menuntutnya.

### Question adalah satu-satunya titik commit

Satu giliran menghasilkan tiga hal. Urutannya wajib, dan hanya yang ketiga yang mengubah dunia menurut control plane:

```
push branch  →  unggah session  →  POST Question (ref + kunci session, idempotency key)
```

Invarian yang dijaga: **Question ada ⇒ ref dan session pasti ada.** Runner mati sebelum POST → tidak ada Question, StepRun masih `running` dengan lease hidup → lease kedaluwarsa → sweep → dijadwalkan ulang sebagai **attempt** baru dari **turn** yang sama. Branch dan blob yang terlanjur ada jadi yatim dan dibersihkan GC. Kerja satu giliran terbuang, tapi itu persis semantik retry yang sudah kita punya — bukan kelas pemulihan baru.

Ditolak: **state machine per-tahap** — tahap kedua tidak benar-benar bisa dilanjutkan karena session-nya ada di disk Runner yang sudah mati. Ditolak: **control plane mem-parse JSONL untuk menurunkan Question** — mengopel control plane ke format file internal tiap agent, yang menurut ticket 01 berbeda-beda antara Claude, Codex, dan sisanya.

### Bentuk interaksi: daftar tertutup berisi tiga

```ts
type Question =
  | { kind: "text";     body: string }
  | { kind: "choice";   body: string;
      options: { id: string; label: string; description?: string }[];
      multi: boolean; allowOther: boolean }
  | { kind: "approval"; body: string }

type Answer =
  | { kind: "text";     value: string }
  | { kind: "choice";   ids: string[]; other?: string }
  | { kind: "approval"; approved: boolean; reason?: string }
```

Skema Zod di `shared`, dipakai control plane, worker, dan web. Daftar tertutup supaya UI punya sesuatu untuk dirender dan validasi jawaban tidak jatuh ke agent — dengan satu bentuk teks saja, agent harus menebak arti "ya", "ok", "gas", dan gerbang persetujuan tidak punya bentuk yang bisa diaudit.

**`edit-artifact` sengaja tidak masuk sekarang.** Bentuk itu memaksa keputusan "Artifact punya versi" diambil di sini, mendahului ticket 15 yang memang memiliki pertanyaan itu. Menambah `kind` belakangan bersifat aditif.

### Penolakan adalah data; alurnya dideklarasikan

`approved: false` **tidak** dengan sendirinya menggagalkan apa pun. Ia dikirim balik ke agent sebagai prompt giliran berikutnya, sama seperti jawaban lain, sehingga bentuk "tolak lalu agent perbaiki" tersedia. Kalau sebuah Step memang harus berhenti saat ditolak, itu ditulis sebagai sifat Step di definisi Pipeline:

```yaml
step review:
  onReject: fail    # atau: continue (bawaan)
```

Question menjawab *apa kata manusia*; definisi Pipeline menjawab *apa akibatnya ke Graph*. Dua bidang, dua pertanyaan — pemisahan yang sama yang ticket 02 tuntut antara "hilir dijadwalkan" dan "Run sukses". **Semantik lengkap enum-nya milik ticket 06.** Kalau `approved:false` langsung menggagalkan StepRun, orang akan memalsukan gerbang persetujuan sebagai `choice` `["terima","tolak"]` untuk menghindarinya, dan audit "siapa menyetujui apa" bocor lewat pintu itu.

### Question ditujukan ke audiens, bukan individu

Sasarannya ditulis di definisi Step — bawaan `trigger()`, bisa juga peran di Project:

```yaml
step review:
  ask: role("reviewer")
```

Siapa pun di dalam audiens boleh menjawab. Balapan diselesaikan dengan compare-and-set:

```sql
UPDATE question
   SET answer = $1, answered_by = $2, answered_at = now()
 WHERE id = $3 AND answered_at IS NULL
```

Nol baris terpengaruh → penjawab kedua dapat pesan tegas *"sudah dijawab oleh Budi 2 menit lalu"*, bukan penolakan senyap. **Identitas penjawab selalu dicatat** — itu yang membuat `approval` bisa diaudit. Kasus "tanya orang tertentu" adalah audiens beranggota satu, bukan mekanisme kedua.

**Batas terhadap ticket 11**: ticket ini hanya menetapkan bahwa Question menunjuk ke sebuah ekspresi audiens. Bentuk ekspresi peran itu sendiri milik ticket 11.

Ditolak: **selalu pemicu Run** — pemicunya cuti dua minggu dan Run menggantung tanpa jalan keluar, dan Run yang dipicu Automation berjalan sebagai ServiceAccount yang tidak punya manusia sama sekali. Ditolak: **kuorum N jawaban** — membuka empat keputusan baru (kebijakan agregasi, jawaban parsial di UI, penjawab berubah pikiran) tanpa satu pun pemicu.

### Tanpa kadaluarsa bawaan; visibilitas menggantikan timer

Menggantung tidak menyandera apa pun — tidak ada lease, Sandbox, atau slot Runner. Jadi tidak ada yang perlu diselamatkan sebuah timer, dan kadaluarsa sewenang-wenang hanya menghancurkan pekerjaan: PRD yang menunggu keputusan bisnis tiga minggu akan mati di hari ketujuh, dan orang akan belajar untuk tidak memakai step interaktif untuk hal penting.

Yang dibangun sebagai gantinya adalah visibilitas: umur Question tampil di UI, dan ada daftar "menunggu manusia" lintas Run yang diurutkan umur. Sebuah Step boleh mendeklarasikan `humanTimeout` opsional; kalau lewat, akibatnya dideklarasikan dengan bentuk yang sama seperti `onReject`.

```yaml
step ask:
  humanTimeout: none        # bawaan
  # humanTimeout: 7d
  # onHumanTimeout: fail | continue
```

**Lubang yang ditinggalkan terbuka dengan sadar**: branch dan blob milik percakapan yang menggantung tidak akan pernah disentuh GC berbasis "Run selesai" dari ticket 02. Retensi khusus HITL dipindahkan ke *Not yet specified* karena ia bergantung pada ticket 15 — apakah diff per giliran itu Artifact menentukan apa yang boleh dihapus.

### Cancel gratis; rewind ditunda tapi laten

Pola cancel ticket 02 (poll heartbeat → SIGTERM ke seluruh process group) **tidak berlaku untuk StepRun yang menunggu** — tidak ada proses untuk disinyal. Cancel di sini adalah dua penulisan baris: StepRun → `cancelled`, Question ditutup dengan alasan sehingga UI berhenti menawarkan formulir. Nol latensi, nol grace period.

Rewind ("ulangi dari giliran 7 dengan jawaban berbeda") **tidak dibangun sekarang, tapi tidak dikubur**: keputusan turn/attempt dan transport session sudah menyimpan branch per `(turn, attempt)` dan blob session per turn cuma-cuma. Kemampuannya sudah laten; menambahkannya belakangan tinggal memberi tombol. Yang belum punya pemicu adalah keputusan-keputusan di sekitarnya — hasil rewind itu Run baru atau cabang di Run yang sama (CONTEXT.md menyatakan Graph dimiliki Run, jadi dua garis waktu di satu Graph perlu dibenarkan dulu), dan apa yang terjadi pada StepRun hilir yang terlanjur jalan. Itu wilayah ticket 06.

### Konsekuensi ke ticket lain

- **06** — memiliki semantik `onReject` dan `onHumanTimeout` terhadap Graph, dan wilayah rewind. Sekarang unblocked.
- **17** — punya kontrak konkret untuk dirender, dan tugas tambahan: mengukur biaya setup per giliran (angka yang dibutuhkan untuk membuka kembali ambang tahan-sandbox). Masih diblokir ticket 15.
- **08 dan 09** — format definisi pipeline wajib memuat `ask:`, `onReject:`, `humanTimeout:`, `onHumanTimeout:`. Sudah dicatat di body kedua ticket.
- **07** — Runner harus bisa di-drain selagi percakapan menggantung; transport session lewat blob store yang membuat itu aman.
- **11** — memiliki bentuk ekspresi audiens (`role(...)`, `trigger()`).
- **15** — mewarisi `edit-artifact` yang ditunda, dan retensi branch/blob percakapan yang menggantung.
- **Blob store** kini punya tiga konsumen (log, Artifact, session).
