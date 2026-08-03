# Prior Art: Eksekusi Graph, Durable Execution, State Transfer, Log Streaming

Riset ini menutup empat area yang masih gelap untuk desain "distributed software factory":
(A) eksekusi graph dengan fan-out dinamis, (B) durable execution untuk Step yang menunggu manusia,
(C) perpindahan state antar step lewat Git, (D) log streaming. Riset leasing/heartbeat/idempotensi
**tidak** diulang di sini — itu sudah selesai dari source `owainlewis/factory`.

Tag verifikasi dipakai di tiap klaim: **[VERIFIED-DOC]** = dari dokumentasi resmi,
**[VERIFIED-SOURCE]** = dari source code publik, **[VERIFIED-ISSUE]** = dari issue/discussion resmi
di repo proyek (perilaku nyata, bukan dokumentasi), **[IMPRESI]** = kesan dari sumber sekunder
(blog, tutorial) yang tidak saya verifikasi langsung ke source/dokumentasi primer.

---

## A. Eksekusi Graph

### A.1 Fan-out dinamis — siapa memberi Key, siapa memberi indeks

| Sistem | Mekanisme | Identitas cabang | Sumber |
|---|---|---|---|
| **Argo Workflows** | `withItems` (list statis di YAML) / `withParam` (list JSON dari `outputs.result` step sebelumnya) | **Value/key-based**: item berupa string sederhana jadi `{{item}}`, item berupa objek JSON diakses via `{{item.key}}` — nama-item tersebut yang membedakan node, bukan indeks murni | [VERIFIED-DOC] `docs/walk-through/loops.md` |
| **Airflow** | `expand()`/`partial()` — dynamic task mapping, jumlah task instance ditentukan saat runtime dari output task sebelumnya (XCom) | **Index-based secara default** (`map_index`, integer, biasanya tidak bermakna bagi user). Sejak Airflow 2.9, `map_index_template` (Jinja) bisa dipasang untuk merender nama bermakna dari task context — tapi ini opsional, defaultnya tetap indeks | [VERIFIED-DOC] `authoring-and-scheduling/dynamic-task-mapping.html`; [VERIFIED-ISSUE] apache/airflow#23020 "Names for expanded tasks" (permintaan fitur ini datang dari user yang gagal membedakan cabang di UI) |
| **Temporal** | Bukan primitif bawaan — child workflow di dalam loop kode (mis. `for item in items: workflow.start_child_workflow(...)`) | **Sepenuhnya di tangan developer** — child workflow ID adalah string yang kode pilih sendiri; tidak ada mekanisme "item" bawaan | [VERIFIED-DOC] `docs/child-workflows` |
| **Prefect** | `.map()` — task dipetakan ke tiap elemen list | Child task jadi first-class task Prefect (retry/skip/pause independen), tapi identitas cabang secara observability terutama berbasis indeks urutan input | [IMPRESI] dari docs/core/concepts/mapping.html — tidak menemukan penamaan bermakna eksplisit |
| **GitHub Actions** | `strategy.matrix` — **statis di parse-time**, tapi bisa "didinamiskan" dengan job upstream yang menulis JSON ke `$GITHUB_OUTPUT`, dikonsumsi via `fromJSON(needs.x.outputs.matrix)` | Key = kombinasi field matrix (mis. `os`, `node`) — ini yang tampil sebagai nama job di UI, jadi bermakna. **Batas keras 256 job per workflow run**, dan matrix harus resolve *sebelum* job-nya mulai (satu kali resolusi, tidak rekursif/bertingkat dalam satu job) | [VERIFIED-DOC] docs.github.com "Running variations of jobs"; limit 256 dari `github/docs` `content/actions/reference/limits.md` |

**Akibat di UI/observability:** Airflow secara eksplisit mengakui masalah ini di changelog fitur
`map_index_template` — tanpa nama bermakna, debugging "cabang mana yang gagal" jadi menyisir index
integer satu-satu. Argo dan GitHub Actions, yang key-nya bermakna dari awal, tidak punya kelas
masalah ini. **Kesimpulan langsung untuk desain kita**: keputusan **Key** (bukan indeks) sebagai
pembeda StepRun bersaudara sudah sejalan dengan pola yang matang (Argo) dan menghindari kelas
masalah yang Airflow harus tambal belakangan.

**Kegagalan pada fan-out sangat besar**: dalam diskusi resmi Argo (argoproj/argo-workflows#5740)
[VERIFIED-ISSUE], pertanyaan soal fan-out ke ~1 juta item **tidak terjawab tuntas** oleh
maintainer — tidak ada jaminan performa/UI untuk skala itu. Ini konsisten dengan model Argo:
setiap fan-out item = 1 Pod Kubernetes, jadi skala fan-out dibatasi oleh kapasitas cluster, bukan
oleh model eksekusinya. **Biaya**: pada skala "puluhan Runner" milik kita, fan-out yang realistis
ada di puluhan–ratusan StepRun paralel, bukan jutaan — jadi soal ini tidak mendesak, tapi validasi
bahwa "1 Key = 1 baris StepRun di DB, discheduling oleh query, bukan dimuat semua ke memori
sekaligus" tetap prinsip yang benar untuk dipegang sejak awal.

### A.2 Bagaimana Join menerima output N cabang

- **Argo**: `outputs.result` dari step loop otomatis teragregasi jadi **satu array JSON** yang bisa
  direferensikan langsung oleh step berikutnya (`{{steps.generate.outputs.result}}` dst.)
  [VERIFIED-DOC]. Syaratnya: tiap iterasi **harus** menghasilkan JSON valid, kalau tidak agregasi
  gagal parse. Ini pola "join membaca hasil gabungan dari sistem", bukan tiap cabang menulis ke
  lokasi terpisah yang di-scan manual.
- **Airflow**: join memakai `xcom_pull(task_ids=[...])` yang mengembalikan **list** nilai XCom dari
  semua map index, atau bisa filter dengan `map_indexes=[...]`. Ini kueri eksplisit ke XCom store
  (tabel Postgres/metadata DB Airflow) — bukan file manifest, bukan argumen command line
  [VERIFIED-DOC] `core-concepts/xcoms.html`. Catatan: fitur "pull banyak map_index sekaligus"
  sendiri baru dibereskan lewat PR apache/airflow#46728 [VERIFIED-ISSUE] — artinya bahkan Airflow
  yang matang pun sempat punya gap di sini.
- **Temporal**: join adalah kode biasa — `await asyncio.gather(*child_workflow_handles)` atau
  setara di SDK lain. Tidak ada "join" sebagai konsep DAG terpisah; itu murni control-flow dalam
  workflow function yang deterministic-replay-safe [VERIFIED-DOC] docs.temporal.io/workflows.
- **Concourse CI** (relevan sebagai pembanding pola "resource" vs pola kita): job tidak fan-out
  dalam satu job resmi, tapi **resource** (termasuk git resource — commit sebagai versi) adalah
  unit versi yang mengalir lewat `get`/`put` step antar job, dengan constraint `passed:` untuk
  menjamin job hilir memakai versi resource yang sama dengan yang lolos di job hulu
  [VERIFIED-DOC + IMPRESI campuran, halaman docs redirect tidak sepenuhnya termuat]. Ini bukan
  fan-out dinamis, tapi menegaskan pola "versi eksplisit + constraint kesesuaian versi lintas job"
  yang relevan untuk skema Ref (Branch + SHA) kita.

**Untuk skala kita** (puluhan StepRun per fan-out, bukan ribuan): pola Airflow (kueri XCom/DB by
task_id + daftar map_index) adalah yang paling dekat dengan bentuk yang sudah cocok dengan model
kita — StepRun sudah baris di Postgres, jadi Join tinggal `SELECT output FROM step_run WHERE
step_id = ? AND run_id = ?` lalu agregasi di kode. Tidak perlu file manifest atau artifact store
terpisah untuk ini; itu overreach untuk N kecil.

### A.3 Kegagalan sebagian — kebijakan per-step vs per-pipeline

| Sistem | Primitif | Level | Detail |
|---|---|---|---|
| **Argo** | `continueOn: {failed: true, error: true}` pada edge dependency | Per-edge (antar dua task) | **[VERIFIED-ISSUE] Peringatan penting**: ada beberapa issue resmi terbuka (argoproj/argo-workflows#13498, #12530, #11395) di mana `continueOn` + `dependencies`/`depends` menghasilkan **status akhir Workflow yang membingungkan** — task hilir jalan (sesuai continueOn), tapi Workflow keseluruhan dilaporkan **sukses** padahal salah satu task gagal. ini bukan bug kecil; ini kelas masalah "continue vs. final success/fail determination tidak dipisahkan dengan jelas" yang developer Argo sendiri akui perlu didesain ulang. |
| **Airflow** | `trigger_rule` per-task, lengkap: `all_success` (default), `all_failed`, `all_done`, `all_done_min_one_success`, `one_failed`, `one_success`, `one_done`, `none_failed`, `none_failed_min_one_success`, `none_skipped`, `always` | Per-task (downstream task memilih sendiri aturannya) | [VERIFIED-DOC]. Airflow eksplisit memperingatkan: **jangan pakai `all_success`/`all_failed` di belakang branching** karena skip menjalar; disarankan `none_failed_min_one_success` untuk pola fan-out/fan-in yang campur skip+gagal. |
| **Buildkite** | `soft_fail` (step boleh gagal tapi tidak memblokir), `allow_dependency_failure` (step hilir boleh jalan meski dependency-nya gagal keras) | Per-step | [VERIFIED-DOC]. Step yang **skip** karena kondisional dianggap "passing" oleh dependency check — beda perlakuan dari step yang **failed**/**canceled**, yang secara default memblokir kecuali `allow_dependency_failure` dipasang. |
| **GitHub Actions** | `continue-on-error` (per-step/job), `strategy.fail-fast` (per-matrix, all-or-nothing) | Job/step tunggal granular; seluruh matrix hanya biner (fail-fast on/off) | [VERIFIED-DOC]/[IMPRESI dari search awal]. Matrix **tidak** punya kebijakan graduated seperti Airflow trigger_rule — cuma "matikan semua job sisa saat satu gagal" atau "biarkan semua jalan". |

**Rekomendasi untuk kita**: kebijakan **per-edge** (Argo) atau **per-task via trigger_rule**
(Airflow) — bukan per-pipeline biner (GHA matrix) — karena kita sudah punya Join eksplisit dan
butuh perilaku beda antar Join (mis. "lanjut kalau minimal satu cabang fan-out sukses" vs "harus
semua sukses"). Bentuk paling sederhana yang cukup: satu enum kecil di definisi Join
(`ALL_SUCCEEDED` / `ANY_SUCCEEDED` / `ALL_DONE`) dipetakan hampir 1:1 ke subset trigger_rule
Airflow yang benar-benar dipakai orang (all_success, none_failed_min_one_success, all_done) —
hindari meniru seluruh 11 trigger_rule Airflow, itu sudah diakui sendiri oleh Airflow team sebagai
sumber salah pakai (`one_failed`/`all_failed` jarang dipakai dan gampang salah). Hindari juga
menyalin bug kelas Argo: pisahkan tegas dari awal antara "apakah StepRun hilir *dijadwalkan*" dan
"apakah Run dianggap *sukses*" sebagai dua keputusan independen di skema data, jangan biarkan satu
flag menjawab dua pertanyaan itu sekaligus — itu persis akar masalah continueOn Argo.

### A.4 Cancel yang merambat ke StepRun di mesin lain (worker outbound-only/di belakang NAT)

Ini titik kunci karena arsitektur kita (Runner outbound-only) sama persis dengan constraint yang
dihadapi Buildkite dan GitHub Actions self-hosted runner — **bukan** Argo/Kubernetes yang punya
kanal push langsung ke Pod.

- **Buildkite** [VERIFIED-DOC, docs.buildkite.com/agent]: agent **polling** — ada "Job Cancellation
  Checker" yang secara berkala poll API untuk status cancel job yang sedang dijalankan agent itu.
  Begitu terdeteksi, agent kirim **SIGTERM** ke proses job, tunggu **grace period** (default 10
  detik, bisa dikonfig via `cancel-grace-period`), lalu **SIGKILL** paksa kalau belum keluar.
- **GitHub Actions runner** [VERIFIED-DOC, docs.github.com/actions/reference/workflow-cancellation]:
  runner kirim **SIGINT** ke proses top-level step, tunggu **7500ms**, lalu **SIGTERM**, tunggu
  **2500ms** lagi, baru kill seluruh process tree paksa. **Catatan penting yang gampang terlewat**:
  runner **hanya** sinyal proses top-level (node/bash/docker) — child process dari situ **tidak**
  menerima SIGINT/SIGTERM langsung kecuali proses top-level meneruskannya. Karena shell default
  (bash) **tidak** meneruskan sinyal ke child saat sedang blocking wait, mayoritas proses turunan
  step GHA sebenarnya tidak pernah dapat kesempatan cleanup dari sinyal cancel — mereka mati kasar
  saat process tree di-kill. Ini cacat desain yang didokumentasikan sendiri di
  actions/runner#1846 [VERIFIED-ISSUE].
- **Argo/Kubernetes** (pembanding, bukan pola yang cocok untuk kita): cancel = kubelet
  menghapus/mengirim sinyal ke Pod langsung, karena kontrol plane Kubernetes punya kanal push
  addressable ke tiap node — constraint NAT/outbound-only tidak berlaku di sana.

**Kesimpulan konkret**: untuk Runner outbound-only, **tidak ada pola "push cancel"** yang valid
tanpa koneksi long-lived yang sudah terbuka (mis. WebSocket/long-poll yang Runner pertahankan). Dua
opsi nyata yang dipraktikkan industri:
1. **Poll murni** (Buildkite): Runner cek status cancel di setiap heartbeat/poll interval yang
   sudah ada — tidak butuh kanal baru, tapi latensi cancel terikat ke interval poll (heartbeat kita
   sudah 10s/30s, jadi cancel akan terasa "lambat" ~10 detik dalam kasus terburuk — ini masih wajar
   untuk unit kerja StepRun berdurasi menit).
2. **Kanal long-lived yang sudah ada** (kalau Runner tetap buka koneksi outbound untuk log
   streaming/heartbeat, cancel bisa "menumpang" di kanal yang sama sebagai pesan push begitu
   koneksi itu sudah terbuka — ini bukan push murni ke NAT, tapi push di atas koneksi yang Runner
   sendiri yang inisiasi).

Untuk **proses child** dalam sandbox agent: ikuti pola grace-period dua-tahap (SIGTERM →
tunggu N detik → SIGKILL), tapi pastikan Runner sendiri (bukan shell perantara) yang mengirim
sinyal ke seluruh process group/tree Sandbox, bukan cuma proses top-level — ini eksplisit
menghindari cacat yang diakui GitHub Actions runner di atas.

**Biaya**: pola poll tidak butuh infra tambahan (pakai heartbeat yang sudah ada). Pola long-lived
channel butuh Runner mempertahankan koneksi (WebSocket/SSE) — kompleksitas tambahan hanya
terjustifikasi kalau kita sudah butuh itu untuk log streaming real-time (lihat bagian D); kalau
begitu, cancel "gratis" menumpang di kanal yang sama.

---

## B. Durable Execution & Step yang Menunggu Manusia

### B.1 Temporal — apa yang sungguh persisten

- **Event History** [VERIFIED-DOC, docs.temporal.io/encyclopedia/event-history]: log lengkap dan
  durable dari setiap Command yang pernah dikeluarkan workflow (mulai Activity, mulai Timer,
  terima Signal, dst.) — **bukan** snapshot state, tapi log kejadian yang **di-replay** untuk
  merekonstruksi state.
- **Replay**: saat Worker restart/crash, Worker baru menjalankan ulang **kode workflow dari awal**,
  tapi setiap kali kode itu memanggil hal yang non-deterministic (Activity, Timer, Signal), hasilnya
  **tidak dieksekusi ulang** — diambil dari Event History yang sudah tercatat. Kode workflow
  berjalan sampai titik yang sama seperti sebelum crash, lalu lanjut normal.
- **Signal vs Update**: Signal = fire-and-forget async (`workflow.signal_workflow` return begitu
  server terima, **tidak** menunggu workflow memprosesnya); Update = mirip tapi bisa
  menunggu hasil balik dan tervalidasi. Baik Signal maupun Update sama-sama masuk Event History
  sebagai Event permanen begitu diterima server — jadi kalaupun tidak ada Worker aktif sama sekali
  saat Signal dikirim, Signal itu tidak hilang; ia menunggu di Event History sampai ada Worker yang
  poll task queue itu [VERIFIED-DOC, docs.temporal.io/workflow-execution/event].
- **Arti "hidup" saat menunggu manusia**: workflow yang menunggu Signal **tidak menahan resource
  aktif apa pun** — tidak ada proses, tidak ada memori terpakai, tidak ada Worker yang "dipegang".
  Yang hidup hanyalah baris Event History di Temporal Server (database). Begitu Signal datang,
  **Worker mana pun** yang polling task queue itu boleh mengambilnya dan me-replay untuk lanjut —
  tidak harus Worker yang sama yang menjalankan sebelumnya. Ini **memisahkan tegas** tiga hal yang
  pertanyaan riset minta dibedakan: "Worker hidup" (proses yang polling, stateless, bisa
  datang-pergi), "Step sedang menghitung" (Worker aktif menjalankan Workflow Task, replay atau
  maju), dan "Step menunggu manusia" (murni baris di storage, nol proses terpakai).

**Biaya infra Temporal**: Temporal Server (persistence layer — Cassandra/Postgres/MySQL +
Elasticsearch opsional untuk visibility query), Worker fleet yang polling task queue, dan
**keharusan menulis kode workflow yang deterministic-replay-safe** (tidak boleh random tanpa seed
tercatat, tidak boleh baca wall-clock langsung, tidak boleh non-deterministic branching) — ini
constraint pemrograman yang menyebar ke semua kode workflow, bukan cuma satu titik. Versioning kode
workflow yang sedang "in-flight" (workflow lama masih replay pakai kode lama) adalah masalah
operasional tersendiri yang harus dikelola (`GetVersion`/patching API).

### B.2 Windmill — suspend/approval

[VERIFIED-DOC, windmill.dev/docs/flows/flow_approval]: step ditandai "Suspend/Approval" di step
config. Step itu berhenti menunggu **webhook call** (URL approval yang dikirim ke manusia/sistem
eksternal). **Poin kunci yang eksplisit didokumentasikan**: *"the worker is freed while
suspended"* — begitu step masuk status suspend, Windmill **melepas** worker slot itu sepenuhnya;
tidak ada proses/thread yang menunggu pasif. State flow (termasuk `resume["argument_name"]` yang
akan diisi payload approval) disimpan di database Windmill, dan saat webhook approval datang,
scheduler Windmill menjadwalkan ulang step berikutnya dengan resume-payload itu sebagai input.

### B.3 Prefect — pause/suspend interaktif

[VERIFIED-DOC, docs.prefect.io/v3/advanced/interactive]: `pause_flow_run`/`suspend_flow_run` dengan
`wait_for_input` bertipe (divalidasi via Pydantic model otomatis dari type annotation). Perbedaan
`pause` vs `suspend` di Prefect: **pause** menahan proses flow run tetap berjalan (blocking,
resource masih dipegang, dipakai untuk jeda pendek); **suspend** melepas infrastruktur flow run
sepenuhnya dan menjadwal ulang saat resume — **suspend** adalah pola yang setara dengan pendekatan
Windmill/Temporal untuk penundaan lama. [IMPRESI: perbedaan pause/suspend saya simpulkan dari nama
API dan konteks docs interactive-workflows, tidak saya verifikasi baris-per-baris ke source Prefect.]

### B.4 Pola yang bisa ditiru **tanpa** dependensi Temporal

Poin sentral untuk pertanyaan tim: **event-sourcing + replay ala Temporal adalah alat untuk
masalah yang berbeda dari masalah kita.** Temporal menyelesaikan "kode workflow arbitrer
(loop/percabangan Turing-complete) yang harus tahan crash di titik mana pun, pada skala jutaan
workflow bersamaan, tanpa membebani programmer dengan penulisan state machine eksplisit." Harganya
adalah constraint determinism yang menyebar ke seluruh kode dan operasional replay/versioning yang
harus dikelola selamanya.

Sistem kita **tidak** punya masalah itu: Graph sudah eksplisit sebagai baris di Postgres (Run,
Step, StepRun) — kita **sudah** menulis state machine eksplisit, bukan kode imperatif yang perlu
di-replay untuk direkonstruksi. Ini persis pola yang dipakai **Argo, Airflow, Buildkite, dan GitHub
Actions — bukan satu pun dari mereka pakai event-sourcing+replay**; semua memakai "state tersimpan
langsung di baris DB + reconciliation loop/poller yang membaca baris itu dan memutuskan langkah
berikutnya." Itulah kelas yang cocok dengan skala puluhan Runner.

**Rekomendasi konkret**, meniru Windmill/Prefect-suspend, bukan Temporal:
- **Interactive Step** = StepRun dengan status `WAITING_FOR_HUMAN` sebagai baris biasa di tabel
  StepRun (bukan proses yang idle).
- **Question** = baris durable terpisah (sudah di kosakata kita) yang menyimpan pertanyaan +
  jawaban, dengan foreign key ke StepRun.
- Begitu StepRun masuk `WAITING_FOR_HUMAN`: **Runner dan Sandbox yang menjalankannya dilepas
  sepenuhnya** — tidak ada proses yang menunggu pasif di mesin manapun; sama seperti prinsip
  Windmill "worker freed while suspended". Ini juga otomatis membuat StepRun **tahan restart
  control plane**, karena tidak ada state di memori proses manapun yang perlu selamat — semuanya
  sudah di Postgres.
- Saat jawaban masuk (Question terisi), control plane menjadwalkan StepRun baru (atau melanjutkan
  StepRun yang sama, tergantung desain) via jalur scheduling normal yang sudah ada untuk Step biasa
  — **tidak butuh mekanisme replay terpisah**, karena "melanjutkan" di sini artinya "jadwalkan
  StepRun berikutnya di Graph dengan input = jawaban", persis pola fan-out/join biasa.
- "Arti hidup" untuk kita: **Run hidup** = baris Run ada dan berstatus aktif (bukan proses).
  **StepRun sedang menghitung** = ada Runner+Sandbox yang memegang lease atas StepRun itu (pola
  leasing yang sudah diriset dari owainlewis/factory berlaku persis di sini). **StepRun menunggu
  manusia** = tidak ada lease sama sekali, murni status di DB + Question menunggu jawaban.

**Biaya**: nol infra tambahan di luar yang sudah direncanakan (Postgres, lease/heartbeat yang sudah
diriset). Ini adalah alasan kuat untuk **tidak** mengambil dependensi Temporal — nilai
event-sourcing+replay-nya (menyimpan program imperatif arbitrer secara durable) tidak dibutuhkan
karena kita sudah memodelkan Graph sebagai data, bukan kode.

---

## C. Perpindahan State Antar Step Lewat Git

### C.1 Siapa yang benar-benar memakai git sebagai bus antar step — dan siapa yang tidak

Temuan paling penting di bagian ini: **saya tidak menemukan orkestrator produksi matang yang
memakai Git sebagai jalur perpindahan data terstruktur antar step**, dalam pengertian yang tim kita
maksud (tiap StepRun push ke Branch, StepRun berikutnya fetch). Yang ada adalah pola-pola yang
mirip tapi berbeda kelas:

- **Argo Workflows** [VERIFIED-DOC, `docs/configure-artifact-repository.md`]: mendukung Git sebagai
  sumber **input artifact** (checkout repo ke awal step) — tapi **secara eksplisit tidak
  mendukung Git sebagai output artifact**. Tabel dukungan resmi Argo menandai Git: input = ya,
  output = **tidak**. Argo memakai S3/GCS/MinIO (content-addressed blob store) untuk semua
  perpindahan output-ke-input antar step/Pod. Ini sinyal kuat: tim Argo secara sadar tidak
  menganggap Git cocok sebagai *write path* pipeline, hanya cocok sebagai *read path* (checkout
  source code).
- **GitLab CI** [IMPRESI dari docs.gitlab.com/turunan]: artifact antar job/stage disimpan di
  object storage milik GitLab sendiri (bukan git), diunduh otomatis oleh job hilir via
  `dependencies`/`needs`. Git repo di GitLab tetap murni source code; tidak dipakai sebagai bus
  data pipeline.
- **Concourse CI** [VERIFIED-DOC parsial]: yang paling dekat secara konsep — resource **git**
  dipakai sebagai unit versi yang mengalir lewat pipeline (commit SHA = versi), dengan constraint
  `passed:` untuk menjamin konsistensi versi antar job. Tapi ini pola "trigger + checkout versi
  tertentu dari repo yang sudah ada", bukan "tiap job push hasil kerjanya sendiri sebagai commit
  baru untuk dikonsumsi job berikutnya". Artifact hasil kerja *dalam* satu job tetap lewat
  filesystem lokal Concourse task, bukan git.
- **GITOps (Flux/ArgoCD)** dan makalah **GITER** (arxiv 2511.04182, akademik, bukan sistem produksi
  luas) [VERIFIED-SOURCE untuk keberadaan makalah, isi klaim di dalamnya tidak saya verifikasi
  lebih jauh]: keduanya memakai git sebagai *bus deklaratif untuk state konfigurasi/deployment*
  (apa yang *seharusnya* berjalan), bukan sebagai jalur data terstruktur antar tahap eksekusi
  pipeline. Beda tujuan dari kebutuhan kita.

**Kesimpulan jujur**: keputusan tim untuk memakai Git Remote sebagai bus StepRun-ke-StepRun adalah
**wilayah yang belum banyak dipetakan oleh sistem produksi mapan** — bukan berarti salah (untuk
kasus khusus "agent AI yang menghasilkan commit sebagai unit kerja alami", git sebagai bus masuk
akal karena Output *memang* sudah berupa Ref git per definisi kosakata kita), tapi tim harus sadar
sedang membangun sesuatu yang tidak punya cetak biru langsung untuk ditiru pada bagian *mekanika*
(penamaan branch, retensi, GC) — hanya prinsip umum dari sistem artifact-store yang bisa dipinjam.

### C.2 Kapan sistem lain terpaksa menambah artifact store terpisah dari git

Argo adalah contoh paling jelas dan terdokumentasi: Git dipertahankan untuk checkout source, tapi
**begitu ada kebutuhan "output satu step jadi input step lain"**, mereka mewajibkan S3-compatible
store. Alasan implisit dari desain ini (disimpulkan dari batasan yang mereka dokumentasikan, bukan
dikutip langsung): artifact biner besar (build output, model weights, log) tidak cocok dengan model
commit git (git tidak dirancang untuk churn tinggi blob besar — riwayat membengkak, clone jadi
lambat, tidak ada garbage collection granular per blob). **Untuk kita**: karena Output kita
didefinisikan sempit (satu Ref + data terstruktur tervalidasi skema — bukan blob besar), dan
Artifact (yang besar, untuk manusia) secara sengaja **dipisahkan** dari Output di kosakata kita,
risiko kelas masalah Argo ini sudah dimitigasi oleh desain kosakata itu sendiri, **asalkan** disiplin
itu benar-benar dijaga: jangan biarkan Artifact besar menyelinap masuk sebagai bagian dari commit
yang dipush StepRun.

### C.3 Skema penamaan Branch dan pembersihan

Tidak ada prior art langsung (git bukan bus di sistem lain), jadi ini murni prinsip umum dari
naming convention CI ephemeral branch + garbage collection [IMPRESI, hasil sintesis dari beberapa
sumber generik, bukan dari satu sistem otoritatif]:
- Keunikan lintas Run/retry/fan-out butuh namespace hierarkis dalam nama branch itu sendiri:
  pola umum industri adalah `<prefix>/<run-id>/<step-key>/<attempt-n>` — tim kita sudah punya
  seluruh komponen ini di kosakata (Run, Step, Key, attempt/StepRun) sehingga skema penamaan
  tinggal menyusun ulang, bukan mendesain dari nol.
- Pembersihan yang tidak merusak riwayat yang masih dirujuk: prinsip umum yang berulang di semua
  sumber adalah **jangan hapus branch berdasarkan umur semata** — hapus berdasarkan **status Run**
  (Run sudah selesai/dibuang **dan** tidak ada Ref StepRun lain yang commit-nya masih dirujuk
  sebagai basis suatu Ref hidup lain). Ini butuh query eksplisit "apakah SHA ini masih dirujuk oleh
  StepRun aktif manapun" sebelum `git branch -D` + `git gc`, karena SHA yang commit-nya sudah tidak
  punya ref penunjuk akan di-GC oleh git itu sendiri secara agresif.

**Biaya**: karena tidak ada prior art langsung, ini adalah area yang tim harus **prototipe dan uji
sendiri**, bukan area tinggal-tiru. Rekomendasi: mulai dari skema penamaan sederhana di atas dan
kebijakan retensi "hapus saat Run selesai + tidak direferensikan", verifikasi dengan beban nyata
sebelum menambah kerumitan (mis. sebelum mempertimbangkan squash/rewrite history untuk hemat
ruang).

---

## D. Log Streaming

### D.1 Buildkite — chunking dan backpressure

[VERIFIED-DOC/SOURCE-adjacent via DeepWiki, dengan catatan ini turunan dari deepwiki bukan source
langsung sehingga saya tandai IMPRESI untuk detail implementasi]: **LogStreamer** agent Buildkite
memecah output job jadi **chunk**, chunk-chunk itu dikonsumsi oleh **beberapa goroutine worker**
(default 3) dari sebuah **queue**, tiap goroutine upload chunk-nya sendiri ke Buildkite API secara
konkuren. Ini pola **bounded worker pool + queue** — backpressure natural terjadi karena jumlah
goroutine upload dibatasi; kalau upload lambat, queue chunk menumpuk di agent (memori lokal agent),
bukan di server. Live tail: [IMPRESI dari hasil pencarian, klaim "25.000 event/detik" berasal dari
blog AWS/Buildkite soal *test analytics* Kafka/Flink mereka — **ini bukan** arsitektur log
streaming job biasa, jangan disamakan; saya tidak menemukan angka backpressure spesifik untuk log
streaming job reguler dari sumber resmi].

### D.2 GitHub Actions

[IMPRESI, sumber sekunder]: log disimpan sebagai **block blob** di object storage (Azure Blob atau
setara), live streaming di UI dilakukan lewat request langsung ke URL blob storage (bukan proxy
lewat backend GitHub setiap saat) — pola ini memisahkan **jalur tulis** (runner append ke blob)
dari **jalur baca** (browser fetch langsung dari blob storage), mengurangi beban di API backend
saat banyak viewer menonton log yang sama secara bersamaan. Saya tidak menemukan dokumentasi resmi
GitHub yang merinci mekanisme chunking/backpressure sisi runner untuk klaim ini — tandai sebagai
kesan dari sumber sekunder, bukan terverifikasi.

### D.3 Argo Workflows — tidak purpose-built untuk ini

[VERIFIED-DOC, `docs/configure-archive-logs.md` + `docs/cli/argo_logs.md`]: live log = `kubectl
logs -f` (stream langsung dari kubelet/Pod, tidak lewat Argo controller sama sekali — controller
cuma tahu Pod-nya ada). Setelah Pod selesai dan dihapus, log **hilang** kecuali `archiveLogs`
diaktifkan, yang lalu menulis log lengkap sebagai **satu artifact** ke S3 artifact repository (jalur
yang sama dengan artifact biasa, bukan sistem log terpisah). Dokumentasi Argo sendiri mengakui:
*"Argo's log archival feature is not purpose-built for indexing, searching, and storing logs"* —
mereka menyarankan integrasi sistem log ter-Kubernetes-aware terpisah (mis. Loki/ELK) untuk
kebutuhan serius. **Pelajaran untuk kita**: live-tail dan archival-untuk-dicari adalah dua masalah
berbeda dengan solusi berbeda; jangan desain satu mekanisme untuk keduanya sekaligus. Live-tail
butuh jalur streaming murah-latensi-rendah; pencarian/retensi jangka panjang butuh index yang tidak
perlu sama dengan jalur live.

### D.4 Bagaimana beberapa cabang paralel ditampilkan tanpa membingungkan

Tidak ada satu pun sumber yang saya baca mendokumentasikan ini secara eksplisit sebagai fitur UI
bernama — tapi pola yang **konsisten muncul secara implisit** di semua sistem (Argo, Buildkite,
GHA) adalah: **log tidak pernah diinterleave lintas node/step/Key dalam satu stream**. Tiap
Pod/job/step host log-nya sendiri secara terpisah (Argo: tiap Pod = 1 log stream by pod name;
Buildkite: tiap job = 1 log; GHA: tiap job dalam matrix = tab UI terpisah dengan nama dari
key matrix). UI menyusun log paralel sebagai **daftar stream terpisah yang dipilih user** (tab/pohon
navigasi berdasar nama node), bukan digabung jadi satu aliran waktu tunggal. Ini konsisten dengan
keputusan kita soal **Key** bermakna — Key itu jadi label tab/baris di UI, bukan cuma metadata
internal.

### D.5 Rekomendasi bentuk untuk skala puluhan Runner

- **Chunking**: StepRun kirim log sebagai chunk berurutan (nomor sequence eksplisit per StepRun,
  bukan mengandalkan urutan kedatangan network) ke control plane lewat koneksi outbound yang sudah
  ada — meniru pola bounded-queue Buildkite: kalau upload lambat, chunk menumpuk **di sisi Runner**
  (memori/disk lokal terbatas dengan cap eksplisit), bukan menekan Postgres control plane.
  Sequence number juga yang membuat resume-setelah-putus mungkin (chunk yang belum ack dikirim
  ulang) — ini idempotency yang sama jenisnya dengan yang sudah diriset untuk lease token.
- **Simpan**: baris/tabel DB untuk log **tidak** direkomendasikan pada volume nontrivial (baris per
  baris log itu I/O berat untuk Postgres yang juga jadi source-of-truth Run/StepRun) — pola Argo
  (blob per StepRun-attempt di object store yang sama dipakai Artifact) lebih pas: satu blob
  append-only per attempt, di-flush berkala; live-tail baca dari buffer in-memory/file lokal
  control plane yang belum di-flush + tail file blob yang sudah. Ini juga otomatis
  menyelesaikan masalah "10 MiB per attempt" dari factory sebagai batas kasar — ganti dengan
  "log tidak dibatasi ukurannya di penyimpanan blob, hanya dibatasi laju chunk yang diterima per
  detik" (backpressure di laju, bukan cap ukuran keras).
- **UI paralel**: tampilkan satu tab/panel per Key StepRun (bukan satu stream tergabung), identik
  dengan pola implisit di Argo/Buildkite/GHA — ini juga selaras dengan keputusan Key bermakna kita.

**Biaya**: pola ini butuh **satu** komponen baru yang belum ada di rencana — object/blob store
untuk log dan Artifact (S3-compatible, self-hosted bisa pakai MinIO). Kalau tim sudah berencana
menyediakan blob store untuk Artifact (yang menurut kosakata kita memang terpisah dari Output/Ref
git), log tinggal menumpang di infra yang sama — bukan komponen infra ketiga yang berdiri sendiri.

---

## Ringkasan Rekomendasi

| Masalah | Bentuk paling sederhana yang masih benar pada skala puluhan Runner | Ditiru dari |
|---|---|---|
| Fan-out dinamis | Key bermakna (bukan indeks) sebagai identitas StepRun bersaudara; jumlah ditentukan dari Output step sebelumnya, StepRun dibuat sebagai baris DB satu-per-satu saat scheduling, bukan dimuat sekaligus ke memori | Argo `withParam` + key-based item (bukan Airflow map_index default) |
| Join | Kueri DB langsung (`SELECT ... WHERE step_id AND run_id`) atas baris StepRun/Output, agregasi di kode Join | Airflow XCom pull by task_id/map_index — cocok karena StepRun kita sudah baris DB |
| Kegagalan sebagian | Enum kecil per-Join (`ALL_SUCCEEDED`/`ANY_SUCCEEDED`/`ALL_DONE`), dan **pisahkan tegas** "StepRun hilir dijadwalkan" dari "Run dianggap sukses" sebagai dua flag independen | Airflow trigger_rule (subset kecil), hindari bug kelas Argo continueOn |
| Cancel merambat | Poll di heartbeat yang sudah ada (bukan push baru); kalau kanal long-lived sudah dibangun untuk log streaming, tumpangkan cancel di situ; sinyal SIGTERM→grace→SIGKILL ke seluruh process tree Sandbox, bukan cuma top-level | Buildkite poll model; hindari cacat sinyal top-level-only GitHub Actions |
| Step menunggu manusia | StepRun `WAITING_FOR_HUMAN` = baris DB tanpa lease aktif, Runner+Sandbox dilepas total; Question baris terpisah; resume = scheduling StepRun biasa. **Tidak** perlu event-sourcing+replay Temporal karena Graph sudah data, bukan kode imperatif | Windmill suspend ("worker freed while suspended") + Prefect suspend_flow_run |
| State antar step lewat git | Skema nama branch `<prefix>/<run-id>/<step-key>/<attempt>`; retensi = hapus saat Run selesai **dan** tidak direferensikan Ref aktif lain; jaga disiplin Output (kecil, terstruktur) vs Artifact (besar, ke blob store) supaya tidak mengulang alasan Argo melarang git sebagai output | Tidak ada cetak biru langsung — area belum dipetakan, perlu prototipe sendiri; prinsip retensi dari GC praktik umum |
| Log streaming | Chunk bernomor sequence dari Runner, backpressure di sisi Runner (bukan Postgres), simpan sebagai blob append-only per attempt (bukan baris DB, bukan cap keras 10 MiB), live-tail dari buffer lokal + tail blob, satu tab UI per Key | Buildkite chunking, Argo pemisahan live-vs-archive, tumpang di blob store yang sama dengan Artifact |

**Yang saya verifikasi langsung ke dokumentasi/source resmi**: Argo withItems/withParam key-based
naming, Argo continueOn bug kelas (issue resmi), Argo Git=input-only, Argo archiveLogs bukan
purpose-built; Airflow trigger_rule lengkap, Airflow map_index default + map_index_template,
Airflow XCom pull multi-map_index; Temporal Event History + replay + Signal durability; Windmill
suspend + "worker freed"; Prefect pause_flow_run/wait_for_input; Buildkite cancel grace period +
poll-based cancellation checker, soft_fail/allow_dependency_failure; GitHub Actions cancel
signal SIGINT/SIGTERM dua tahap + cacat child-process, matrix 256-job limit + dynamic matrix via
fromJSON.

**Yang hanya kesan dari sumber sekunder (blog/tutorial), bukan diverifikasi ke source/dokumentasi
primer**: detail LogStreamer Buildkite (goroutine count, di luar arsitektur umum), arsitektur log
GitHub Actions (blob storage + jalur baca langsung), perbedaan pause/suspend Prefect secara rinci,
GITER paper sebagai representasi tren git-as-bus (satu makalah akademik, bukan bukti adopsi
produksi).
