# Model credential, secret, dan akses repo

Type: grilling
Status: resolved
Blocked by: 04, 05, 07

## Question

Ketika agent berjalan di dalam sandbox pada mesin orang lain, ia memakai API key siapa dan kredensial git siapa — dan bagaimana keduanya sampai ke sana tanpa bocor?

Untuk tim internal, ini pertanyaan paling berbahaya di seluruh map. Agent memegang kunci berbayar dan akses tulis ke repo, lalu mencetak ribuan baris ke log.

1. **Kunci agent** — `ANTHROPIC_API_KEY` dan sejenisnya milik siapa: satu kunci organisasi, satu kunci per user, atau kunci per pipeline? Kalau per user, run yang dipicu webhook memakai kunci siapa (tidak ada manusia yang memicunya)?
2. **Akses repo** — worker harus clone repo privat dan push branch. Pilih di antara deploy key per repo, GitHub App installation token berumur pendek, PAT bersama, atau kredensial per job. Sertakan kasus **git host self-hosted** (Gitea/Forgejo), karena keseluruhan sistem harus bisa self-host. Zoom ke ticket 04.
3. **Penyimpanan** — secret disimpan di mana dan dienkripsi bagaimana. Kunci enkripsi hidup di mana pada instalasi self-host, dan apa yang terjadi saat kunci itu dirotasi.
4. **Scoping** — apa yang mencegah pipeline di repo A membaca secret milik repo B. Model izinnya bagaimana, dan siapa yang boleh memberi akses.
5. **Pengantaran ke sandbox** — sandcastle memakai `.sandcastle/.env`. Apakah kita menulis file itu, dan siapa yang menghapusnya setelah step selesai. Apakah secret ikut dalam payload job atau diambil terpisah dengan token sekali pakai.
6. **Redaksi log** — bagaimana nilai secret disensor dari output agent sebelum sampai ke UI dan penyimpanan. Di mana penyensoran terjadi: di worker sebelum dikirim (aman tapi tidak bisa diperbaiki belakangan), atau di control plane (bisa diperbaiki tapi nilai mentah sempat melintasi jaringan)?
7. **Agent yang bertingkah** — agent bisa menjalankan perintah sembarang di dalam sandbox. Apa yang menghalanginya membaca secret step lain, mencetak kunci ke stdout dengan sengaja, atau mendorong ke branch yang bukan miliknya. Sebutkan apa yang **tidak** kita lindungi, dan mengapa itu bisa diterima untuk tim internal.
8. **Rotasi dan pencabutan** — bagaimana kunci yang bocor diganti, dan apa yang terjadi pada run yang sedang berjalan.

Pakai model worker dari ticket 07 (khususnya isolasi antar step di worker yang sama).

Batas keras yang diwarisi dari jawaban ticket 07, perlakukan sebagai premis:

- Secret dan token repo **hanya hidup di payload klaim StepRun dan env Sandbox** — tidak pernah ditulis ke disk Runner, tidak pernah dipakai ulang antar StepRun.
- Satu Sandbox per StepRun, dihapus beserta workspace-nya saat selesai; Runner adalah kolam org, jadi dua Project memang berbagi mesin.
- Token repo per-StepRun **harus bisa dicabut seketika**, karena revoke Runner bekerja sebagai fencing: mesin yang dicabut mungkin masih menjalankan Sandbox-nya, dan yang menghentikannya adalah tulisannya ditolak.

## Answer

Digrill bersama ticket 11 dalam satu sesi identity & access. Dua masukan dari user membelokkan sebagian besar jawaban ini: **git host-nya GitHub**, dan **sebagian Runner adalah mesin macOS untuk build Xcode**.

### Kunci agent — dua tingkat, dan Project tidak pernah memegang credential

Lock ticket 05 (*credential menempel ke Principal, tidak pernah ke Run*) dipertahankan utuh, tapi ia punya lubang praktis: Automation tidak punya manusia, jadi jalur kunci non-manusia wajib ada apa pun keputusannya. Dan kalau tiap User wajib membawa kunci sendiri, orang ke-8 yang join tidak bisa menjalankan apa pun — friksi yang selalu diakali dengan mem-paste satu kunci ke semua akun, sehingga "isolasi credential antar user" jadi kalimat di spec yang tidak ada di kenyataan.

Jalan keluarnya: **kunci Project menempel ke ServiceAccount milik Project itu**, bukan ke Project. Tidak ada entitas baru, dan invarian 05 terjaga secara struktural. Resolusi saat penjadwalan, berhenti di kecocokan pertama:

1. Credential milik Principal pemicu.
2. Credential ServiceAccount default Project — **hanya kalau `allowSharedAgentCredential` menyala**. Default **mati** untuk Project baru.

Keduanya kosong → StepRun `failed` **sebelum Sandbox dibuat**, bukan 401 misterius di dalam sandbox. Flag itu membuat ketegangan antara kecepatan dan attribusi jadi keputusan sadar yang tercatat di audit, bukan sesuatu yang bocor diam-diam.

**Attribusi biaya selalu ke Principal pemicu**, terlepas credential siapa yang dipakai. Itu dua pertanyaan berbeda dan tidak boleh dijawab satu kolom.

### Akses repo — GitHub App wajib; rekomendasi ticket 04 dikoreksi

User memilih **GitHub**. Itu membatalkan rekomendasi ticket 04 (*"jangan tiru GitHub App — dirancang untuk marketplace SaaS multi-tenant, over-engineered untuk instance internal"*). Larangan itu hanya berlaku kalau host-nya Gitea/Forgejo, yang memang sudah punya token per-job bawaan. Di GitHub tidak ada mekanisme setara untuk sistem pihak ketiga — `GITHUB_TOKEN` diterbitkan Actions sendiri dan tidak bisa kita minta. Sisanya gugur terhadap premis 07: deploy key tidak punya expiry, PAT terikat akun manusia dan lolos dari offboarding. **GitHub App installation token adalah satu-satunya kandidat**, bukan yang terbaik di antara beberapa.

Fakta terverifikasi ([docs.github.com](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app), [REST apps/installations](https://docs.github.com/en/rest/apps/installations)): umur **1 jam**, bisa dipersempit saat mint ke `repository_ids` (maks 500) **dan** subset `permissions`, dicabut seketika lewat `DELETE /installation/token`, **tidak bisa di-refresh**.

**Mint dua kali per giliran** — saat Sandbox dibuat (fetch) dan tepat sebelum push, karena satu giliran bisa lewat 1 jam. Tiap mint dipersempit ke Repository yang Pipeline itu sentuh, `contents:write` dan tidak lebih. `DELETE` saat teardown, jangan tunggu expiry: revoke Runner ticket 07 bekerja sebagai fencing dan butuh penolakan seketika. Fan-out 50 cabang = 100 panggilan, jauh di bawah 5.000/jam per installation.

**Token per-turn, bukan per-StepRun** — dan ini kebetulan yang beruntung, bukan desain. Ticket 14 memutuskan agent mengakhiri run-nya tiap kali bertanya, jadi Sandbox tidak pernah hidup selama percakapan menggantung. Kalau 14 memilih tool yang memblokir di dalam sandbox, umur token 1 jam akan memaksa kita membongkarnya.

### Penyimpanan

Satu tabel `secrets`, **AES-256-GCM**, nonce acak per baris, **AAD = secret id + owner Principal id** — mengikat ciphertext ke pemiliknya, sehingga menukar baris antar Principal gagal dekripsi, bukan cuma dilarang oleh kode.

Master key dibaca dari **file** yang path-nya ditunjuk env var, **bukan nilainya di env var**. Alasannya spesifik: vektor CVE-2025-66032 adalah agent dibujuk membaca `/proc/self/environ`. Rotasi lewat kolom `key_version` — tulis dengan kunci baru, re-enkripsi baris lama di latar, buang kunci lama setelah nol baris tersisa. Tanpa envelope encryption dan tanpa Vault; ticket 04 sudah menyatakan itu berlebihan untuk satu tim.

### Scoping

Batas berhenti di **Project** (ticket 05). Kolom `owner_principal_id` + `project_id` di tabel yang sama, dan kueri resolusi saat penjadwalan **selalu** menyertakan keduanya — secret Project lain tidak pernah masuk kandidat karena tidak pernah ter-`SELECT`, bukan karena disaring belakangan. Riset ticket 04 menemukan **tidak satu pun dari lima sistem CI melakukan scoping per Principal**; ini tetap wilayah tanpa cetak biru dan kita mengisinya sendiri.

### Pengantaran ke Sandbox — pertanyaannya gugur

Sub-pertanyaan 5 bertanya apakah kita menulis `.sandcastle/.env` dan siapa yang menghapusnya. **Tidak pernah ditulis.** `run()` menerima `sandbox.env`/`agent.env` langsung (`src/mergeProviderEnv.ts`), diteruskan sebagai `docker run -e KEY=VALUE`. Tidak ada file, tidak ada yang perlu dihapus.

Secret di-resolve **saat penjadwalan**, ikut di payload `/claim` lewat TLS, hidup **hanya di memori proses Runner**. Hanya secret yang **Step itu deklarasikan** yang dikirim — bukan seluruh koleksi Project, meniru pola on-demand Forgejo.

Harga yang diterima sadar: `docker run -e` membuat nilainya terlihat oleh `docker inspect` dan `/proc/<pid>/environ` **di mesin itu**.

### macOS dan Xcode — `exec:host` naik jadi jalur rutin

Build Apple tidak bisa masuk kontainer; tidak ada macOS container, dan Docker Desktop di Mac sendiri menjalankan VM Linux. Opsi VM macOS ephemeral (**tart**, OCI-registry-backed, Virtualization.framework) sempat dipertimbangkan dan **ditolak**: menjalankan VM macOS di dalam host macOS berdedikasi menambah boot time dan image puluhan GB untuk batas yang, dengan mesin sudah dipatok per-Project, tidak membeli apa-apa.

Tapi VM tadi diam-diam menutup satu lubang yang menganga kalau dibuang tanpa pengganti: **agent di host-mode bisa membaca identitas Runner-nya sendiri.** Ticket 07 mengunci `runner-id + secret di disk`. Agent menjalankan perintah sembarang. Di `exec:docker` kontainer yang menghalangi; di bare macOS tidak ada. Satu `cat` dan agent naik dari "proses di dalam job" jadi **Runner itu sendiri** — bisa menarik StepRun Project lain dan membaca secret-nya. Eskalasi privilege, bukan kebocoran biasa.

**Penggantinya, harganya hampir nol:** proses Runner dan proses agent jalan sebagai **dua user macOS berbeda**. Runner sebagai `_factory` (pemilik `runner.secret`, `chmod 600`); agent di-spawn sebagai `_factoryjob` yang tidak bisa membacanya. Ini juga yang membuat `pf` bisa di-scope ke user agent untuk egress, dan `HOME` per-StepRun bisa dibuang bersih saat teardown.

**Signing certificate**: `.p12` dan provisioning profile ikut payload klaim seperti secret lain, diimpor ke **keychain sementara di `HOME` milik `_factoryjob`** dengan password acak, dihapus saat teardown termasuk saat StepRun gagal atau di-cancel — bukan di `~/Library/Keychains` bersama. Certificate tetap milik **Project**, bukan milik mesin.

Konsekuensinya, **premis ticket 07 diubah**: dari *secret tidak pernah menyentuh disk Runner* jadi *secret tidak pernah **menetap** di disk Runner*.

Tart dicatat di kabut sebagai jalan keluar yang murah ditambahkan nanti — seam provider sandcastle sudah ada (`SandboxFactory.ts`, `run.ts`, `createWorktree.ts` punya **nol** referensi fungsional ke string `"docker"`), jadi kalau isolasi antar-Project di macOS jadi kebutuhan nyata, itu satu file provider.

### Egress dan redaksi — kontrol utamanya bukan yang kami kira

Ticket 04 menyimpulkan kontrol utama adalah **default-deny egress**, bukan redaksi log. Itu benar sebagian, dan setelah GitHub terkunci bingkainya harus dikoreksi.

Default-deny + allowlist SNI per Project (tanpa MITM TLS) menghentikan tujuan **yang tidak dikenal**. Tapi jalur eksfiltrasi CVE-2025-66032 adalah **push ke repo** — tujuan yang menurut definisi kita izinkan. Allowlist tidak menyentuhnya sama sekali.

Yang benar-benar membatasi blast radius di sana ada dua:

- **`repository_ids` sempit saat mint** — agent tidak bisa menyentuh repo di luar yang Pipeline itu sebut.
- **Branch protection wajib di branch default**, dengan GitHub App kita **tidak** masuk daftar bypass. Token GitHub App tidak bisa dipersempit per-ref (`contents:write` berlaku se-repo), jadi ini satu-satunya yang menahan agent mendorong langsung ke `main`. **Factory menulis ke `run/*` dan membuka PR; manusia yang merge.** Ini prasyarat terdokumentasi untuk mendaftarkan Repository ke sebuah Project.

Egress tetap jalan, perannya diturunkan jadi kontrol untuk tujuan tak dikenal. Allowlist bawaan: git host, endpoint API agent, registry paket; untuk macOS tambah `developer.apple.com`, `*.apple.com`, `cdn.cocoapods.org`. Pesan kegagalan **wajib menyebut host yang diblokir**, supaya menambahkannya satu klik, bukan satu jam debugging.

**Redaksi** di **satu corong tunggal di Runner sebelum persist**, dilewati baris log **dan** `AgentStreamEvent` — bukan dua implementasi. Sandcastle sendiri punya **nol** mekanisme redaksi (grep `redact`/`mask` di `src/` → nol match), jadi ini seluruhnya milik kita. Yang diredaksi: nilai persis tiap secret StepRun itu, plus bentuk base64 dan URL-encoded-nya. Nilai **di bawah 6 byte ditolak saat disimpan** alih-alih diredaksi — Buildkite diam-diam melewatkannya dan itu bug produksi nyata (buildkite/agent#3588). Lalu berhenti; tidak ada perlombaan regex. **Tidak retroaktif.**

### Rotasi bukan pencabutan — dua tombol berbeda

- **Rotate** (rutin) — **tidak mengganggu Run yang sedang jalan.** StepRun yang sudah memegang nilai lama meneruskannya; StepRun berikutnya dapat nilai baru, karena secret di-resolve saat penjadwalan. Kalau rotasi membunuh Run, orang berhenti merotasi — dan itu jauh lebih buruk daripada paparan beberapa menit.
- **Revoke as compromised** — membatalkan StepRun yang sedang memegang secret itu, ditandai di audit. Disruptif, dan disengaja.

Token repo tidak butuh keduanya (umur ≤1 jam, sudah di-`DELETE` saat teardown). Master key lewat `key_version`. Runner yang dicurigai bocor lewat `desired_state` ticket 07.

### Yang sengaja TIDAK dilindungi

1. **Agent yang jahat by design.** Kita bertahan terhadap agent yang *dibujuk*, bukan yang dirancang mencuri. Ia bisa mencetak kuncinya sendiri ke stdout.
2. **Eskalasi privilege lokal di Runner `exec:host`.** Tidak ada batas keras; setara tingkat kepercayaan laptop developer.
3. **Secret terlihat lewat `ps` / `docker inspect`** oleh siapa pun yang punya shell di Runner itu.
4. **Project `admin` membocorkan secret Project-nya sendiri.** Ia memang memegangnya.
5. **Pembersihan log retroaktif.** Secret yang telanjur tersimpan tidak dibersihkan saat secret baru ditambahkan.

### Konsekuensi ke ticket lain

- **Ticket 04** — rekomendasi "jangan tiru GitHub App" batal untuk kasus GitHub. Bingkai "egress adalah kontrol utama" dipersempit.
- **Ticket 07** — premis *secret tidak pernah menyentuh disk Runner* jadi *tidak pernah menetap*; `exec:host` naik dari jalan darurat jadi jalur rutin.
- **Ticket 08** — skema definisi harus menampung `runsOn`, deklarasi secret per Step, dan daftar Repository yang disentuh (dipakai untuk mempersempit `repository_ids`).
- **Ticket 18** — redaksi terjadi di Runner sebelum persist; log streaming mewarisi corong itu.
