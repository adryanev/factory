# Siklus hidup worker dan pencocokan pekerjaan

Type: grilling
Status: resolved
Blocked by: 02, 05

## Question

Sebuah mesin berubah dari "baru diinstal" menjadi "sedang mengerjakan step" lewat langkah apa saja, dan bagaimana control plane memutuskan step mana pergi ke worker mana?

1. **Pendaftaran** — operator memasang worker di laptop. Apa yang ia jalankan, dan dari mana join token datang: dibuat di UI lalu ditempel, atau file konfigurasi? Apa yang worker terima kembali dan di mana ia disimpan di disk. Bagaimana worker yang sama dikenali setelah restart atau ganti IP.
2. **Deklarasi kapabilitas** — apa yang worker beri tahu tentang dirinya: mode eksekusi (Docker/Podman atau host langsung), agent CLI mana yang terpasang, CPU/RAM, jumlah step bersamaan yang sanggup, dan label bebas. Apakah kapabilitas dideteksi otomatis, ditulis manual, atau keduanya.
3. **Pencocokan** — bagaimana sebuah step menyatakan kebutuhannya, dan bagaimana control plane memilih di antara worker yang memenuhi syarat. Apakah cukup label sederhana seperti Buildkite, atau butuh yang lebih kaya.
4. **Concurrency** — satu worker mengerjakan berapa step sekaligus. Siapa yang menegakkan batas itu, worker atau control plane? Bagaimana slot dilepas ketika step selesai.
5. **Leasing** — protokol yang menjamin satu step diberikan ke tepat satu worker saat banyak worker long-poll bersamaan. Zoom ke ticket 02.
6. **Heartbeat dan kematian** — interval heartbeat, ambang batas mati, dan apa yang terjadi pada step yang sedang berjalan saat worker hilang. Bedakan keluar bersih (worker pamit) dari hilang mendadak (laptop ditutup). **Awas**: heartbeat tidak boleh diartikan "sedang bekerja", karena step bisa idle berjam-jam menunggu manusia — ticket 14 memutuskan arti "hidup", jadi jangan memutuskannya di sini.
7. **Drain dan pencabutan** — bagaimana worker dikeluarkan tanpa membunuh pekerjaan yang sedang berjalan, dan bagaimana worker yang dicurigai bocor dicabut aksesnya seketika.
8. **Versi** — worker dan control plane akan berbeda versi. Apakah worker menolak bekerja kalau terlalu tua, dan bagaimana pembaruan worker dilakukan.
9. **Isolasi antar step** — dua step dari user berbeda berjalan di worker yang sama. Apa yang menjamin mereka tidak saling melihat workspace atau credential.

Pakai istilah dari ticket 05 (khususnya kata untuk "worker" versus "agent").

## Answer

Runner adalah **satu kolam milik org**, dan seluruh siklus hidupnya berjalan di atas dua endpoint HTTP polos. Tidak ada penjadwal terpisah: matching hidup di dalam kueri klaim ticket 02, dan satu-satunya kanal perintah adalah balasan heartbeat.

### Kolam org, bukan kolam per Project

Runner didaftarkan ke org; StepRun dari Project mana pun boleh mendarat di sana. Ini memindahkan seluruh beban batas keamanan ticket 05 ke **Sandbox dan scoping credential**, bukan ke kepemilikan mesin — utang yang dibayar di bagian isolasi di bawah.

Ditolak: **Runner milik satu Project** — isolasi jadi gratis secara struktural, tapi tiap Project menuntut mesinnya sendiri dan operator mendaftarkan laptop yang sama berkali-kali. Ditolak: **allowlist Project per Runner** — jalan keluar yang masuk akal untuk mesin sensitif, tapi belum ada yang memintanya; menambahkannya belakangan bersifat aditif (satu kondisi lagi di kueri klaim).

### Masuk kolam: token sekali pakai, identitas di disk

```
UI: [Buat join token] → FCT-JOIN-a3f9…   (sekali pakai, TTL 1 jam)

$ factory-runner join --url https://cp --token FCT-JOIN-a3f9…
    → INSERT runners (id=rnr_7hk2, name=laptop-adryan)
    → ~/.factory/runner.json { id, secret }   chmod 600
    → join token mati

$ factory-runner start        # cukup runner.json seterusnya
```

Identitas Runner adalah **runner-id di file itu**, bukan hostname maupun IP — ganti jaringan tidak berarti apa-apa, dan menghapus file itu berarti mesin baru. Ini pola GHA runner dan bootstrap token kubelet, dan ia menjaga invarian ticket 03 (Runner ≠ Principal) tetap struktural.

Ditolak: **enrollment token bersama berumur panjang** — mudah dipasang massal, tapi satu token bocor = seluruh kolam bocor, mencabut satu mesin memaksa rotasi semua, dan nama yang dideklarasikan sendiri bisa ditabrak. Ditolak: **sertifikat mTLS** — lebih kuat dan kedaluwarsa sendiri, tapi menuntut kita menjalankan CA, memutar sertifikat, dan mengurus clock skew sebelum ada satu pengguna pun.

### Kapabilitas: fakta diprobe, kebijakan ditulis

Dua sumber kebenaran yang berbeda, jadi dua jalur yang berbeda.

```
auto — dideteksi tiap start, tidak bisa disunting di UI
  exec    : [docker]            ← probe socket Docker/Podman; nihil → host
  agents  : claude@2.1, codex@0.9   ← PATH + --version
  cpu 10  ram 32Gi  os darwin/arm64

manual — ~/.factory/runner.yaml
  slots   : 3
  labels  : [office-vpn, m4]

heartbeat membawa { caps_hash } → berubah? control plane minta laporan penuh
```

Konsekuensinya: upgrade Claude Code di sebuah laptop **tidak** butuh registrasi ulang, dan matching tidak pernah ditipu deklarasi manual yang basi. Batas antara keduanya adalah "bisakah ini diperiksa mesin" — `slots` dan label tidak bisa, karena batas sesungguhnya (RAM laptop yang sedang dipakai orangnya, akses VPN, lokasi fisik) hanya diketahui operator.

Ditolak: **semua manual** — config berbohong diam-diam; tertulis `codex` padahal sudah dicopot, StepRun mendarat lalu gagal di sandbox, dan kegagalannya muncul jauh dari sebabnya. Ditolak: **semua auto** — operator kehilangan kendali atas laptopnya sendiri, dan matching kehilangan satu-satunya kait untuk fakta yang tidak terprobe.

### Matching: kebutuhan tersirat, dievaluasi di kueri klaim

Pertanyaan ticket ini ("bagaimana control plane memilih worker mana") **terbalik** begitu Runner outbound-only: yang terjadi adalah Runner datang membawa tag dan slot kosongnya, lalu control plane memilih *StepRun mana* yang cocok untuk mesin yang sedang bertanya. Karena itu matching bukan komponen — ia adalah predikat di dalam kueri leasing yang sudah diputuskan ticket 02.

```yaml
step build:
  agent: claude          # → requires agent:claude
  runsOn: [office-vpn]   # → requires office-vpn
```

```
step_run.requires = ["agent:claude", "exec:docker", "office-vpn"]
runner.tags       = ["agent:claude","agent:codex","exec:docker",
                     "office-vpn","m4","os:darwin"]

SELECT … FROM step_run
 WHERE state = 'ready'
   AND $runner_tags @> requires          -- jsonb containment, GIN index
   AND (SELECT count(*) FROM step_run
         WHERE lease_runner = $me
           AND lease_expires_at > now()) < $slots
 ORDER BY ready_at
 LIMIT 1 FOR UPDATE SKIP LOCKED
```

Kasus normal **tidak menulis apa pun**: `agent: claude` sudah berarti butuh CLI claude, mode sandbox sudah berarti `exec:docker`. `runsOn:` hanya untuk yang tidak bisa diturunkan. Pemilihan di antara yang cocok murni **FIFO `ready_at`** — belum ada prioritas.

Ditolak: **antrean bernama (Buildkite)** — sesederhana `WHERE queue = ANY(...)`, tapi kapabilitas nyata tidak ikut terperiksa; operator harus menjaga sendiri agar isi antrean `claude-docker` benar-benar punya claude dan docker, dan mesin yang salah masuk gagal saat runtime. Ditolak: **skoring/bidding** — butuh pandangan atas semua kandidat sekaligus padahal modelnya pull, jadi pekerjaan harus ditahan agar bisa dibandingkan, dan itu memperkenalkan penjadwal berstatus yang persis ingin dihindari.

### Concurrency: Runner penegak, control plane pagar

Runner penuh **tidak long-poll sama sekali** — backpressure alami, benar meski jaringan putus-nyambung, dan tanpa negosiasi. Control plane menegakkan lapis kedua di kueri yang sama (klausa `count(*) < $slots` di atas). Ini defense-in-depth yang sama bentuknya dengan partial unique index milik owainlewis/factory: Runner yang bug atau berversi lama tidak bisa membanjiri dirinya sendiri, dan `slots` tetap berarti sesuatu di sisi server.

Slot lepas saat lease berakhir — selesai, gagal, dibatalkan, atau `awaiting-human`. Yang terakhir datang gratis dari ticket 14: menunggu manusia berarti tidak ada lease, jadi tidak butuh aturan pelepasan slot tersendiri.

### Hidup, mati, dan jatah retry

Angka diadopsi dari owainlewis/factory (ticket 00), dua window yang sengaja dipisah:

| | kirim | ambang |
|---|---|---|
| heartbeat Runner | 10s | online 30s |
| lease per-StepRun | 10s | expire 30s |
| sweep | tiap 5s | + **sekali saat startup, sebelum listener dibuka** |

Sweep-saat-startup itu yang menutup lubang pemulihan setelah restart control plane. Arti "hidup" tetap milik ticket 14: heartbeat berarti *mesin hidup*, tidak pernah berarti *step bekerja*.

**Lease yang hilang memakan jatah `attempt` yang sama dengan kegagalan biasa.** Pertanyaannya memang satu — berapa kali StepRun ini sudah dimulai — jadi satu penghitung, bukan dua. Yang dipisah adalah *alasannya*, bukan anggarannya:

```
step_run_attempt
  n | reason      | runner
  1 | lease_lost  | laptop-A     ← laptop ditutup
  2 | crashed     | ci-1         ← exit 1
```

Ini memberi perlindungan poison-pill gratis: StepRun yang membunuh mesinnya sendiri (OOM) tidak akan berkeliling menjatuhkan seluruh kolam tanpa batas. UI tetap bisa membedakan "kodemu gagal 3x" dari "laptopmu tutup 3x" lewat kolom `reason`.

Ditolak: **penjadwalan ulang karena infra itu gratis** (`infra_restarts` terpisah yang tidak dibaca retry policy) — terasa lebih adil, tapi tidak ada satu angka pun yang menghentikan StepRun beracun. Ditolak: **anggaran terpisah yang lebih longgar** — satu knob lagi di definisi Pipeline yang harus dipahami dan disetel orang, padahal belum ada yang mengeluhkan penghitung tunggal.

### Drain dan revoke: satu kolom, dibalas di heartbeat

Control plane tidak bisa memerintah mesin apa pun — ia hanya bisa **menjawab** saat mesin bertanya, dan **menolak** saat mesin itu tidak berhak lagi.

```
runners.desired_state : active | draining | revoked

POST /heartbeat → { desired_state: "draining" }
    Runner: berhenti long-poll, habiskan lease yang dipegang, keluar
    kueri klaim juga menolaknya — pagar yang sama seperti slot

revoke:
    UPDATE runners SET desired_state='revoked', secret=NULL
    sweep lease-nya SEKARANG → step_run ready, reason=lease_lost
    cabut token repo per-StepRun (ticket 04)
```

`factory-runner drain` di CLI lokal hanya memanggil API yang sama, jadi drain punya satu mekanisme, bukan dua. SIGTERM ke proses Runner = drain lokal lalu keluar.

Yang penting dipahami tentang revoke: **ini fencing, bukan pembunuhan.** Mesin yang dicabut mungkin masih menjalankan Sandbox-nya beberapa menit — dan itu tidak berbahaya, karena secret-nya mati (semua request 401) dan token repo per-StepRun-nya dicabut, sehingga ia tidak bisa push branch maupun POST hasil. Eksekusi ganda yang tulisannya ditolak bukan kerusakan.

Ditolak: **drain lokal saja / revoke server saja** — operator tidak bisa men-drain laptop yang sedang tidak ia pegang, padahal itu justru kasusnya. Ditolak: **revoke menunggu lease kedaluwarsa** — menutup jendela eksekusi ganda dua kali (fencing tetap dibutuhkan untuk kasus lain) sambil memperlambat pemulihan setengah menit.

### Versi: protokol integer, terpisah dari rilis

```
runner → { release: "0.4.2", protocol: 3 }
control plane: minProtocol = 4

heartbeat : DITERIMA → UI menampilkan laptop-A ⚠ unsupported (protocol 3 < 4)
klaim     : ditolak  → tidak pernah dapat StepRun
balasan   : { latest_release: "0.6.0" } → lencana "perbarui"
```

Runner basi **tetap terlihat**, bukan menghilang diam-diam — itu inti pilihan ini, dan sekaligus knob darurat kalau ada bug protokol. Kedua angka berubah dengan irama berbeda: rilis untuk manusia, protokol hanya saat kontrak berubah.

Pembaruan **manual** — operator menjalankan ulang installer. Ditolak: **self-update otomatis (pola GHA)** — kolam selalu seragam, tapi menuntut biner bertanda tangan, penanganan update setengah jalan, rollback, dan izin tulis ke direktori instalasi di laptop orang: seluruh cerita distribusi biner sebelum ada satu pengguna. Ditolak: **semver rilis saja** — tiap rilis rutin memaksa pertanyaan "ini breaking atau bukan".

### Isolasi: docker bawaan, host mode harus diminta

Ini utang dari keputusan kolam bersama. `exec:docker` masuk **otomatis** ke `requires` tiap StepRun, jadi kolam bersama secara bawaan hanya memakai mesin dengan batas kontainer nyata. Runner host-mode tetap boleh join dan tetap terlihat, tapi tidak akan pernah cocok kecuali Step-nya sengaja menulis `runsOn: [exec:host]`, dan Project-nya mengizinkan.

Tiga aturan di atasnya:

1. **Satu Sandbox per StepRun**, tidak pernah dipakai ulang, dihapus beserta workspace-nya saat selesai.
2. **Secret dan token repo ikut di payload klaim StepRun itu saja**, hanya masuk env Sandbox, **tidak pernah menyentuh disk Runner**.
3. **Egress default-deny dari Sandbox**, sesuai kontrol utama ticket 04.

Host mode dengan demikian jadi jalur sadar untuk mesin milik satu tim, bukan lubang bawaan.

Ditolak: **melarang host mode di kolam org** — batasnya paling tegas, tapi membatalkan premis map bahwa docker-vs-host adalah konfigurasi Runner yang sah, dan menutup kasus nyata (toolchain lokal, perangkat terpasang). Ditolak: **isolasi lewat user OS sekali pakai** — menuntut root di laptop orang, berbeda perilaku antara macOS dan Linux, dan menyeret kita menulis manajemen user OS yang tidak ada hubungannya dengan orkestrasi.

### Transport: HTTP polos, dan heartbeat adalah satu-satunya kanal perintah

```
POST /claim      (long-poll ≤30s)   { tags, free_slots }
  ← { step_run, ref, secrets, lease_token }   |   204

POST /heartbeat  (tiap 10s)         { leases: [...], caps_hash }
  ← { desired_state: "active",
      cancel: ["sr_7hk2"],
      latest_release: "0.6.0" }
```

Satu heartbeat memperpanjang **seluruh** lease yang dipegang sekaligus, dan balasannya membawa semua perintah. Latensi cancel ~10 detik — pola Buildkite yang ticket 02 sebut, wajar untuk StepRun berdurasi menit. Cancel-nya sendiri tetap seperti ticket 02: SIGTERM ke seluruh process group Sandbox, grace period, lalu SIGKILL.

Yang dibeli: **control plane tetap stateless** — tidak ada afinitas Runner-ke-instance, jadi menjalankan lebih dari satu instance tidak menuntut jalur pesan antar-instance; lolos proxy korporat mana pun; bisa diuji dengan curl.

Ditolak: **WebSocket persisten** — latensi terbaik dan satu koneksi per mesin, tapi membuat control plane berstatus dan memindahkan matching dari kueri klaim ke penjadwal berbasis dorongan. Ditolak: **SSE untuk perintah** — membawa seluruh masalah afinitas instance milik WebSocket sambil hanya membeli separuh manfaatnya. Kanal persisten baru dipertimbangkan kalau log streaming benar-benar menuntutnya; saat itu ia **menambah jalur, bukan membongkar** yang ini.

### Bawaan yang diambil tanpa perdebatan

- Runner yang lama offline **tetap terdaftar** sebagai `offline` sampai operator menghapusnya. Tanpa auto-deregister — mesin yang hilang harus terlihat hilang, bukan lenyap dari daftar.
- Pemilihan StepRun di antara yang cocok murni **FIFO `ready_at`**. Tanpa prioritas, tanpa fairness antar Project.

### Akibat ke ticket lain

- **Ticket 10** (credential dan akses repo) terbuka, dan mewarisi batas keras dari sini: secret hanya hidup di payload klaim dan env Sandbox, tidak pernah di disk Runner; token repo per-StepRun harus bisa dicabut seketika untuk mendukung fencing.
- **Ticket 06** mewarisi `requires` sebagai bidang yang dikompilasi dari definisi Step, dan `attempt.reason` sebagai bagian model kegagalan.
- **Ticket 11** mewarisi satu pertanyaan baru: siapa yang berhak mengizinkan `exec:host` untuk sebuah Project.
- **Kabut log streaming** kini punya batas transport: tanpa kanal persisten, unggahan log adalah POST chunk bernomor sequence lewat HTTP biasa — persis yang ticket 02 rekomendasikan.
