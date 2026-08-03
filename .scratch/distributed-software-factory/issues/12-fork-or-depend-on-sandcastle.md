# Sandcastle dipakai, di-fork, atau tidak dipakai sama sekali

Type: grilling
Status: resolved
Blocked by: 01, 06

## Question

Worker meng-import sandcastle sebagai paket npm, mem-fork-nya, atau hanya meminjam idenya?

Ini pertanyaan yang kamu ajukan di awal, dan sengaja ditaruh belakangan: ia hanya bisa dijawab jujur setelah kita tahu apa yang sandcastle sungguh berikan (ticket 01) dan apa yang eksekusi DAG sungguh butuhkan (ticket 06).

1. **Kesenjangan** — sandingkan daftar "hal yang sandcastle tidak lakukan" dari ticket 01 dengan kebutuhan dari ticket 06. Berapa besar jaraknya, dan apakah jarak itu bisa ditutup dari luar lewat API publik.
2. **Empat jalur, dengan harganya**:
   - *Tidak dipakai*: kalau ticket 00 merekomendasikan membangun di atas Fabro atau owainlewis/factory, lapisan eksekusi agent datang dari sana dan sandcastle tidak punya tempat — Fabro menjalankan agent lewat kode Rust-nya sendiri. Kalau ini yang terjadi, ticket ini tertutup lebih awal dan alasannya dicatat.
   - *Dependency*: `import` apa adanya, bungkus yang kurang. Dapat perbaikan upstream gratis. Terikat pada laju rilis dan keputusan desain orang lain.
   - *Fork*: salin dan ubah sesuka hati. Kendali penuh, tapi setiap perbaikan upstream jadi kerja merge, dan itu berlangsung selamanya.
   - *Inspirasi*: tulis mesin eksekusi sendiri, contek pola branch strategy dan provider. Tidak ada beban merge, tapi harus menulis ulang bagian yang sudah matang.
3. **Uji kesehatan proyek** — dari ticket 01: seberapa aktif dipelihara, seberapa stabil API publiknya, dan apakah ia diperlakukan sebagai library atau sebagai alat pribadi penulisnya. Fork terhadap proyek yang bergerak cepat jauh lebih mahal daripada fork terhadap proyek yang tenang.
4. **Jalur mundur** — kalau memilih dependency dan ternyata mentok, seberapa mahal pindah ke fork nanti? Kalau murah, mulai dari dependency adalah pilihan yang jelas. Sebutkan biayanya secara konkret.
5. **Kontribusi ke upstream** — apakah kekurangan yang kita temukan layak diajukan sebagai PR ke sandcastle, sehingga fork bisa dihindari sama sekali.

Rekomendasi awal untuk diuji: mulai sebagai dependency, isolasi seluruh pemakaiannya di balik satu modul di paket `worker`, sehingga jalur mundur ke fork atau ke mesin sendiri tetap murah.

**Kebutuhan konkret dari ticket 06 yang harus diuji ke API sandcastle**: control plane memegang **satu-satunya jam**, jadi timeout idle dan completion milik sandcastle harus bisa **dimatikan** atau diset jauh di atas `timeout` StepRun. Kalau ternyata tidak bisa dimatikan, itu argumen fork pertama yang berasal dari kebutuhan nyata, bukan dari kenyamanan. Ticket 06 juga menuntut SIGTERM sampai ke **seluruh process group** di dalam Sandbox dengan grace 30 detik — periksa apakah `run()` sudah memberi itu atau hanya menyinyal proses puncak (cacat yang GHA sendiri akui, dicatat ticket 02).

## Answer

**Dependency, tanpa fork, versi di-pin eksak.** Seluruh jawaban di bawah berdasar pembacaan source `mattpocock/sandcastle` @ `e99f832` (v0.12.0, `@ai-hero/sandcastle`, MIT).

### Dua probe ticket 06: satu lolos, satu gagal

**Jam sandcastle tidak bisa dimatikan — dan tidak perlu.** `idleTimeoutSeconds` (default 600s) dan `completionTimeoutSeconds` (default 60s) memakai `??` (`Orchestrator.ts:321-325`), jadi hanya `undefined` yang memicu default dan tidak ada nilai "off". Tapi kekhawatiran "dua jam berbalapan" salah sasaran: **keduanya bukan wall-clock**. Idle timer di-reset tiap baris output (`resetTimer()` di `onLine`, `Orchestrator.ts:184`); completion timer baru mulai setelah completion signal terlihat. Ia mengukur *agent menggantung tanpa output* — pertanyaan berbeda dari jam control plane. Set jauh di atas `timeout` StepRun, selesai. **Bukan argumen fork.** (Jam ketiga ada di `startSandbox.ts:71`, `CONTAINER_START_TIMEOUT_MS = 120_000`, tapi ia hanya membungkus `create()`.)

**`run({ signal })` tidak membunuh apa pun.** Ia cuma di-race: `Effect.raceFirst(raced, Deferred.await(abortDeferred))` (`Orchestrator.ts:224-232`). `spawn()` dipanggil tanpa `signal` dan tanpa `detached: true`, di docker (`sandboxes/docker.ts:266`) maupun host (`sandboxes/no-sandbox.ts:79`) — tidak ada process group, tidak ada handle untuk membunuh. sandcastle mengakuinya sendiri: *"sandbox.exec doesn't natively support AbortSignal, so we race via Deferred"* (`SandboxLifecycle.ts:281-282`). Abort ⇒ `run()` kembali, **agent terus jalan**. `close()` di `no-sandbox` adalah no-op (`sandboxes/no-sandbox.ts:164-167`), jadi di host mode tidak ada apa pun yang membunuh agent — dan ticket 10 baru saja menjadikan `exec:host` jalur rutin untuk Xcode. **Cancel harus kita bangun.**

### Cancel dibangun di luar sandcastle, dua mekanisme

Docker: Runner membuat network per StepRun `factory-<steprun-id>` — yang **sudah wajib ada** untuk default-deny egress ticket 10 — lalu `docker({ network: … })` provider bawaan (`DockerOptions.network`, `sandboxes/docker.ts:71-78`). Cancel: `docker ps -q --filter network=factory-<steprun-id>` → `docker stop -t 30 <id>`. Deterministik dan bebas balapan antar slot, karena nama network milik kita dan unik per StepRun; tidak bergantung pada `sandcastle-${randomUUID()}` (`sandboxes/docker.ts:154`) yang bukan kontrak publik dan tidak pernah keluar dari closure. **Ini memberi semantik ticket 06 persis — SIGTERM ke PID 1 container, grace 30 detik, lalu SIGKILL — dari perintah `docker` standar.** Host: `spawn` detached milik provider kita → `kill(-pid, SIGTERM)` → 30 detik → `SIGKILL`. `signal` tetap dioper ke `run()` supaya ia kembali segera; `docker exec` yang menggantung melihat container mati dan keluar non-nol, jadi cancel berakhir sebagai kejadian teramati, bukan hang.

### Provider: Docker bawaan dipakai, host ditulis sendiri

`docker()` bawaan sudah menerima `network`, `cpus`, dan `--user` uid/gid — cukup untuk ticket 10. **Menulis ulang ±300 baris hanya demi cancel ditolak**; uid/gid mapping, selinux label, dan perbaikan bug Docker lintas platform tetap tanggungan upstream.

Provider **host** ditulis sendiri (±200 baris) dan **didaftarkan sebagai `tag: "bind-mount"`** dengan mount sebagai fungsi identitas. Dua alasan, keduanya bukan cancel:

1. Agent harus jalan sebagai user OS `_factoryjob` (ticket 10). `no-sandbox` menjalankannya sebagai user Runner dan `sudo` di situ **eksplisit no-op** (`sandboxes/no-sandbox.ts:66`).
2. **`tag: "none"` mematikan session capture secara senyap.** Gerbangnya menuntut `bindMountHandle` (`Orchestrator.ts:508-512`), yang hanya diisi di cabang bind-mount dan isolated (`SandboxFactory.ts:565`, `:657`); cabang `none` memanggil `makeEffect()` tanpa field itu (`SandboxFactory.ts:366-372`). Tidak ada error — blok itu cuma dilewati. **Tanpa keputusan ini, ticket 14 patah senyap di Runner macOS** (tidak ada sesi untuk diangkut ⇒ HITL tidak bisa resume) dan **ticket 20 kehilangan `usage`** (`parseSessionUsage` ada di dalam blok yang sama).

Jalur bind-mount terverifikasi bebas asumsi container: `startBindMountSandbox` cuma menyusun `mounts` sebagai data lalu menyerahkannya ke `create()` kita (`startSandbox.ts:124-168`), `normalizeMounts` transformasi murni, dan yang dipakai orchestrator sebagai `sandboxRepoDir` adalah `handle.worktreePath` yang **kita** kembalikan (`startSandbox.ts:158`) — jadi pemetaan sandbox↔host jadi identitas 1:1. `sessionStorage` path-nya juga sudah bisa dikonfigurasi lewat `claudeCode({ sessionStorage: { hostProjectsDir, sandboxProjectsDir } })` (`AgentProvider.ts:353-357`), yang sekaligus menegakkan batas user ticket 10: sesi ditulis `_factoryjob`, disalin keluar oleh Runner.

### Kenapa fork ditolak

Diuji dua kali, ditolak dua kali, dengan angka:

- **49 rilis, `grep -c "### Major Changes"` → 0.** Komposisinya 12 Minor (semua aditif) + 48 Patch. Biaya fork sebanding dengan churn upstream ke arah merusak; di sini nol.
- **48 patch itu adalah tagihan fork.** Isinya bug ekor panjang lintas platform: `noSandbox()` `spawn sh ENOENT` di PowerShell, Docker "too many colons" di Windows, Dockerfile Cursor gagal saat GID host `20` bentrok `dialout`, worktree basi dipakai ulang, session capture no-op senyap di bind-mount, `merge-to-head` tidak merge. Tiga dari enam menyentuh macOS/Windows — persis platform yang ticket 10 paksakan.
- **Ujian #3 ticket ini membalik arahnya.** ~75 commit/minggu (1.193 commit W12–W27, puncak 326, 156 PR ter-merge). Cepat **tapi tidak merusak** = target dependency terbaik dan target fork terburuk.
- **Fork+sync action tidak menghapus kerja merge, ia menjadwalkannya.** Fast-forward otomatis hanya bekerja selama divergensi nol — dan fork tanpa divergensi adalah dependency dengan langkah tambahan. Versi jujurnya membuka PR konflik untuk diselesaikan manusia, di codebase yang bukan kita tulis, pada laju 75 commit/minggu, selamanya.
- **Keberatan pokoknya lebih sederhana: divergensinya nol.** Provider host kita adalah `SandboxProvider` — ia hidup di repo kita lewat `createBindMountSandboxProvider()` entah sandcastle di-fork atau tidak. Cancel terjadi di luar sandcastle sepenuhnya. Push, transport sesi, redaksi log semuanya wrapper. **Tidak ada satu baris core yang ingin kita ubah.**
- **Asimetri opsi**: dependency → fork tetap murah (satu direktori + satu baris `package.json`); fork → dependency tidak pernah murah. Memilih dependency **menyimpan** opsi fork; memilih fork **membakarnya**. Dan fork mahal justru saat upstream aktif, murah justru saat upstream mati — fork sekarang berarti membayar harga tertinggi untuk asuransi yang baru berguna saat harganya sudah turun sendiri.

Tiga ketakutan di balik dorongan fork, masing-masing dijawab lebih murah: upstream merusak kita → **pin eksak** (`0.12.0`, bukan `^`), upgrade tidak pernah terjadi tanpa dipilih; perlu ubah sesuatu → **`pnpm patch`**, dan patch yang membengkak adalah **pemicu fork berbasis bukti**, bukan firasat; upstream ditinggalkan → fork **saat itu terjadi**, momen termurah karena tidak ada lagi churn untuk dimerge. (Commit terakhir 2026-06-29; sunyi 5 minggu, tapi jeda serupa pernah terjadi di W20 dan W23.)

### Seam: satu modul, satu handle

`packages/runner/src/agent-runtime/` adalah **satu-satunya** tempat yang `import @ai-hero/sandcastle` di seluruh monorepo, ditegakkan lint rule. Ia mengekspor `startTurn(spec) → { done: Promise<TurnResult>, cancel(): Promise<void> }` — bentuk `RunHandle` Warren dari ticket 00, karena ticket 14 menjadikan satuan kerja "satu giliran" (Sandbox dilepas tiap giliran) dan ticket 07 mengirim cancel dari luar lewat heartbeat, jadi modul ini tidak boleh cuma `await execute()`. `cancel()` menyembunyikan kedua mekanisme di atas dari pemanggil.

**Registry `RuntimeProvider` gaya Warren ditolak secara eksplisit.** Nilai pola itu adalah satu seam dengan banyak implementasi runtime — dan seam itu **sudah ada dan bukan milik kita untuk dibuat**: `SandboxProvider` sandcastle, persis tempat provider docker dan host duduk. Menumpuk abstraksi kita di atasnya berarti dua lapisan untuk satu keputusan, dengan satu pemanggil dan satu implementasi. Yang diambil dari Warren adalah bentuk handle-nya, bukan registry-nya.

Ini yang menjaga jalur mundur tetap sehari kerja: fork nanti mengubah isi satu direktori + satu baris `package.json`; turun ke "hanya lapisan agent, orchestrator sendiri" juga mengubah isi direktori itu saja — permukaan `startTurn` ke Runner tidak bergeser. Jalur mundur itu terkonfirmasi terbuka: `AgentProvider` dan `createBindMountSandboxProvider` **keduanya diekspor publik** (`src/index.ts:62-75`).

### Gerbang upgrade: tiga perilaku internal yang harus dites

Pin eksak berarti tidak ada upgrade otomatis, tapi pin hanya **menunda** kejutan. Jawaban di atas bersandar pada tiga perilaku yang **bukan kontrak publik** sandcastle, dan ketiganya patah senyap:

1. **Gerbang session capture** — `tag: "bind-mount"` ⇒ `bindMountHandle` terisi ⇒ capture jalan (`Orchestrator.ts:508-512`, `SandboxFactory.ts:565`). Menopang provider host; ticket 14 dan 20 berdiri di atasnya.
2. **`handle.worktreePath` dipakai verbatim** sebagai `sandboxRepoDir` (`startSandbox.ts:158`). Dasar pemetaan identitas host↔sandbox.
3. **Idle timer di-reset tiap baris output** (`Orchestrator.ts:184`). Dasar klaim "set besar lalu abaikan"; kalau berubah jadi wall-clock, jam kedua hidup lagi dan ticket 06 terlanggar.

Karena itu gerbang upgrade adalah **contract test di repo kita** yang menegakkan ketiganya terhadap versi terpasang, jalan di CI: bump pin → baca changeset → test hijau. Tanpa test ini pin cuma menunda kejutan; dengan test ini ia benar-benar jadi perlindungan.

Yang **tidak** rapuh: `DockerOptions.network` (API publik terdokumentasi) dan penemuan container lewat `docker ps --filter network` — yang terakhir tidak menyentuh sandcastle sama sekali, jadi kebal upgrade. Itu properti gratis dari keputusan memakai provider Docker bawaan.

### Kontribusi upstream: tidak ada

Kandidatnya dua, keduanya gugur. `exec` tanpa AbortSignal sudah **diakui sadar** di komentar sandcastle sendiri — melaporkannya berakhir "known", dan setelah cancel dibangun di luar kita tidak butuh itu diperbaiki. Session capture senyap di `tag: "none"` **adalah** bug nyata (0.11.0 memperbaiki varian bind-mount dari gerbang yang sama, jadi preseden mereka memperlakukannya sebagai bug), dan melaporkannya akan mengubah kompromi tag di atas dari keharusan jadi pilihan — tapi diputuskan tidak dilaporkan. Konsekuensinya dicatat sebagai kabut di map.
