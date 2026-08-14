# Sandcastle sebagai execution engine di dalam worker — analisis API surface

Repo: `@ai-hero/sandcastle` v0.12.0, single npm package (bukan monorepo/workspaces —
tidak ada field `workspaces` di `package.json`; `docs/` adalah Next.js/Fumadocs
site terpisah dengan `package.json`-nya sendiri, tidak dependency library).
Semua path di bawah relatif terhadap root repo yang di-clone di
`.../scratchpad/repos/sandcastle`.

Pertanyaan pokok tim: **apa yang sandcastle berikan cuma-cuma, dan di mana
batasnya, kalau ia dijalankan oleh worker yang dikendalikan control plane
jarak jauh?** Jawaban singkat: sandcastle adalah *execution engine* yang solid
untuk **satu step, satu proses Node, satu mesin** — tapi semua hal lintas-mesin
(git remote sebagai bus, resume sesi di worker lain, cost tracking, secret
redaction) tidak ada dan harus dibangun sendiri sebagai lapisan di atasnya.

---

## 1. Permukaan API publik

Semua entry point diekspor dari `src/index.ts:1-99`.

### `run()`

```ts
// src/run.ts:482-493
function run<T, A extends AgentProvider>(
  options: RunOptions<A> & { output: OutputObjectDefinition<T> },
): Promise<RunResult & { output: T }>;
function run<A extends AgentProvider>(
  options: RunOptions<A> & { output: OutputStringDefinition },
): Promise<RunResult & { output: string }>;
function run<A extends AgentProvider>(
  options: RunOptions<A>,
): Promise<RunResult>;
```

`RunOptions` (`src/run.ts:332-427`) lengkap: `agent`, `sandbox`, `cwd?`,
`prompt?`/`promptFile?`, `maxIterations?`, `hooks?`, `promptArgs?`,
`logging?`, `completionSignal?`, `idleTimeoutSeconds?`,
`completionTimeoutSeconds?`, `name?`, `copyToWorktree?`, `branchStrategy?`,
`resumeSession?`, `signal?` (AbortSignal), `timeouts?`, `output?`.

### `createSandbox()`

```ts
// src/createSandbox.ts:904-906
const createSandbox = async (options: CreateSandboxOptions): Promise<Sandbox>
```

`CreateSandboxOptions` (`src/createSandbox.ts:63-98`): `branch` (wajib,
string eksplisit), `baseBranch?`, `sandbox`, `cwd?`, `hooks?`,
`copyToWorktree?`, `timeouts?`. Sandbox handle punya `.run()`, `.interactive()`,
`.exec()`, `.close()` — bisa dipakai ulang lintas banyak `run()` call di
container/worktree yang sama (`src/createSandbox.ts:224-251`).

### `createWorktree()`

```ts
// src/createWorktree.ts:215-217
const createWorktree = async (options: CreateWorktreeOptions): Promise<Worktree>
```

`CreateWorktreeOptions` (`src/createWorktree.ts:66-86`): `branchStrategy`
(hanya `"branch"` atau `"merge-to-head"` — `"head"` adalah *compile-time type
error* karena head berarti tidak ada worktree), `cwd?`, `copyToWorktree?`,
`hooks?`, `timeouts?`.

### Kritis: bisakah semuanya datang dari argumen runtime tanpa file config?

**Ya, sepenuhnya.** Tidak ada file config JSON/YAML apa pun yang dibaca oleh
`run()`/`createSandbox()`/`createWorktree()`:

- **Prompt**: `prompt: "..."` inline langsung dipakai verbatim, tanpa file
  (`src/PromptResolver.ts:36-37`). `promptFile` hanya opsi alternatif, bukan
  kewajiban.
- **Repo**: `cwd` opsional, default `process.cwd()`; hanya divalidasi sebagai
  direktori yang ada (`src/resolveCwd.ts:21-47`) — bukan file config, tapi
  memang harus berupa **git working copy yang sudah ada** karena
  `WorktreeManager.getCurrentBranch()` langsung `git rev-parse --abbrev-ref
  HEAD` (`src/WorktreeManager.ts:92-97`) dan akan gagal keras kalau bukan repo
  git.
- **Branch**: string biasa di `branchStrategy: { type: "branch", branch:
  "..." }` atau `CreateSandboxOptions.branch` — tidak perlu file apa pun.
- **Agent**: dipilih dengan memanggil factory function langsung —
  `claudeCode("claude-opus-4-8", {...})`, `codex(...)`, `pi(...)`, dll
  (`src/AgentProvider.ts`) — bukan nama string yang di-resolve dari config.

Satu-satunya file opsional yang dibaca (bukan ditulis) adalah
`.sandcastle/.env` (`src/EnvResolver.ts:56-73`) — kalau tidak ada, cukup
kembalikan `{}` tanpa error (`src/EnvResolver.ts:10-13`, `catchAll`). Jadi
untuk worker terkontrol control plane, seluruh env bisa dikirim lewat
`sandbox.env`/`agent.env` di call `run()` tanpa file `.env` sama sekali.

**Efek samping ke disk yang tidak bisa dihindari** (bukan config, tapi tetap
perlu diketahui worker punya local disk yang writable):
- `.sandcastle/logs/*.log` — default logging, bisa dioverride ke path lain
  atau mode `stdout` (`src/run.ts:646-655`), tapi kalau `type: "file"` selalu
  menulis ke disk.
- `.sandcastle/worktrees/<name>/` — dibuat untuk strategi `merge-to-head` dan
  `branch` (`src/WorktreeManager.ts:305`); **strategi `head` sama sekali tidak
  membuat worktree**, langsung pakai `hostRepoDir` (`src/SandboxFactory.ts:346-352`,
  komentar eksplisit "Head mode: use hostRepoDir directly, no worktree.").
- `InitService.ts` (`sandcastle init` CLI) adalah scaffold generator terpisah
  untuk pemakaian standalone-CLI (menulis `.sandcastle/agent-workflows/`,
  template, dll) — **sama sekali tidak dipanggil** oleh `run()`/`createSandbox()`/
  `createWorktree()`. Aman diabaikan untuk pemakaian sebagai library.

---

## 2. Branch strategy — mekanik persis

Tiga varian (`src/SandboxProvider.ts:246-283`), diimplementasi di
`src/SandboxLifecycle.ts:178-544` dan `src/WorktreeManager.ts`.

**`head`** — bind-mount saja, tidak ada worktree, agent menulis langsung ke
`hostRepoDir`/`process.cwd()` yang di-bind-mount ke container. Ditolak kalau
dipasangkan dengan isolated provider (`src/run.ts:516-520`).

**`merge-to-head`** — nama branch temp dibuat
`sandcastle/<YYYYMMDD-HHMMSS>-<6hex>` (`src/WorktreeManager.ts:82-89`), agent
commit di worktree terpisah, lalu setelah agent selesai:
1. `git checkout --detach` di sandbox (lepas dari temp branch).
2. Kalau ada commit baru: `git merge "<tempbranch>"` dijalankan **di host**,
   di direktori `hostRepoDir`, via `execAsync` biasa
   (`src/SandboxLifecycle.ts:439-471`) — **ini git merge lokal murni, tidak
   ada push/fetch remote sama sekali di jalur ini.**
3. `git branch -D "<tempbranch>"` menghapus temp branch di host
   (`src/SandboxLifecycle.ts:477-483`).

**`branch`** (`NamedBranchStrategy`) — nama branch eksplisit dari caller,
worktree di `.sandcastle/worktrees/<branch-dengan-slash-diganti-dash>/`,
commit **tetap di branch itu, tidak pernah di-merge balik ke HEAD host**.
Kalau dipanggil ulang dengan nama branch yang sama dan worktree lama masih
bersih (tidak dirty) dan tertinggal (behind) dari `origin/<branch>`,
sandcastle melakukan **satu-satunya interaksi remote di seluruh codebase**:
`git fetch origin <branch>` lalu `git merge --ff-only origin/<branch>`
(`src/WorktreeManager.ts:213-275`, ADR `docs/adr/0003-reuse-worktree-by-default.md`).
Kalau fetch gagal, diverged, atau worktree dirty — refresh dilewati, worktree
dipakai apa adanya, **tidak fatal**.

### Apakah `branch` bisa push ke remote?

**Tidak pernah.** Grep menyeluruh atas `src/` untuk `git push`/`push` tidak
menghasilkan satu pun call site fungsional (hanya satu komentar dokumentasi
di `src/sandboxes/test-isolated.ts:6` yang membahas hal lain). Sandcastle
tidak pernah push, tidak pernah clone dari remote untuk memulai run — ia
mengasumsikan `cwd` sudah berupa checkout lokal yang hidup, dan satu-satunya
kontak remote adalah *pull* read-only pada skenario reuse di atas.

### Penanganan konflik

Tidak ada resolusi konflik otomatis di mana pun. Kalau `git merge` di
merge-to-head gagal, sandcastle melempar error dengan pesan eksplisit: temp
branch **dipertahankan**, instruksi manual diberikan ("git merge
`<branch>`, lalu `git branch -D <branch>`") — `src/SandboxLifecycle.ts:440-453`.
Untuk strategi `branch`, kondisi diverged (unpushed commits + origin sudah
maju) juga **tidak dicoba di-merge sama sekali** — worktree dipakai apa
adanya (`src/WorktreeManager.ts:256-261`).

### Implikasi untuk "git remote sebagai bus antar step"

Sandcastle **tidak memberi apa pun** untuk pola ini — semua plumbing git-nya
lokal terhadap satu clone di `cwd`. Tidak ada entry point "clone branch X dari
remote lalu jalankan", tidak ada push otomatis setelah commit. Tapi ia juga
**tidak menghalangi** — strategi `branch` dengan `baseBranch` eksplisit cocok
dipasangkan dengan wrapper: sebelum `run()`, `git fetch && git checkout` branch
yang relevan di worker; sesudah `run()`, `git push` sendiri dari luar sandcastle
(commit sudah ada di `hostRepoDir`/worktree host, jadi `git push` biasa dari
situ cukup). Ini murni wrapper tipis (beberapa baris shell/Effect), bukan hal
yang butuh fork sandcastle.

---

## 3. Provider — kontrak interface

Full definisi di `src/SandboxProvider.ts:1-331`.

- **Bind-mount** (`BindMountSandboxProvider`): `create(options) =>
  Promise<BindMountSandboxHandle>` yang wajib implement `exec()`,
  `copyFileIn()`, `copyFileOut()`, `close()`, dan opsional `interactiveExec()`
  (`src/SandboxProvider.ts:24-64`).
- **Isolated** (`IsolatedSandboxProvider`): sama tapi `copyIn()` (bukan
  `copyFileIn`, mendukung direktori) dan tanpa host bind-mount otomatis
  (`src/SandboxProvider.ts:101-141`).
- **No-sandbox**: `exec()` + wajib `interactiveExec()`, jalan langsung di host
  (`src/SandboxProvider.ts:195-226`).

**Syarat keras** yang ditulis berulang di JSDoc (3x, kata-kata identik):
implementasi `exec()` **wajib** streaming baris-demi-baris lewat `onLine` —
"A buffered/batch implementation that only calls onLine after the process
exits does NOT satisfy this contract" (`src/SandboxProvider.ts:30-34`,
`:107-111`, `:201-203`). Ini persis fondasi live-tail (lihat §4).

**Seberapa dalam asumsi Docker/Podman?** Sangat dangkal — hanya di file
implementasi provider itu sendiri (`src/sandboxes/docker.ts`,
`src/sandboxes/podman.ts`, keduanya cuma wrapper `spawn`/`execFile` atas CLI
`docker`/`podman`). Saya cek langsung: `src/SandboxFactory.ts`,
`src/SandboxLifecycle.ts`, `src/Orchestrator.ts`, `src/createSandbox.ts`,
`src/createWorktree.ts` — **nol** referensi fungsional ke string `"docker"`
(hanya muncul di contoh JSDoc seperti `docker({ imageName: ... })`). Core
sandcastle benar-benar hanya bergantung pada interface `exec`/`copyFileIn`/
`copyFileOut`/`close`. Menulis provider custom (misalnya membungkus worker's
own process spawn, atau Kubernetes `exec`) realistis — cukup 3-6 method, tidak
ada coupling Docker yang perlu dibongkar.

`@daytona/sdk` dan `@vercel/sandbox` adalah `peerDependencies` opsional
(`package.json` — `peerDependenciesMeta` keduanya `optional: true`) untuk
provider isolated bawaan.

---

## 4. Log dan progres

Jalur data: `provider.exec()`'s `onLine` callback →
`Orchestrator.invokeAgent` (`src/Orchestrator.ts:140-189`) parsing baris jadi
`ParsedStreamEvent` lewat `provider.parseStreamLine()` (text/result/tool_call/
session_id/usage) → `AgentStreamEmitter.emit()`
(`src/AgentStreamEmitter.ts:37-44`) → callback pengguna
`logging.onAgentStreamEvent` (**hanya mode `type: "file"`**,
`src/run.ts:234-244`, dipanggil **sinkron per event, real time**) — dan
paralel ditulis ke file log via `FileDisplay` yang bisa di-`tail -f` (hint ini
memang diprint eksplisit ke terminal saat startup:
`src/run.ts:112-125`, "tail -f <path>").

### Bisakah log di-tail live?

**Ya, dua jalur**: (a) `tail -f` file fisik di `.sandcastle/logs/...log`
karena FileDisplay menulis incremental, bukan batch di akhir; (b) callback
programatik `onAgentStreamEvent` di opsi `logging: { type: "file",
onAgentStreamEvent }` yang menerima event `text`/`toolCall`/`raw` **saat
event itu muncul**, bukan setelah iterasi selesai. Opsi `logging` yang sama
tersedia di `run()`, `sandbox.run()` (`src/createSandbox.ts:121-122`), dan
`worktree.run()` (`src/createWorktree.ts:140`) — jadi tersedia di semua entry
point yang relevan untuk worker.

**Catatan penting**: `onAgentStreamEvent` **tidak ada** untuk mode
`type: "stdout"` (mode interaktif terminal) — hanya mode `"file"` yang punya
hook programatik. Untuk worker headless yang perlu forward log ke UI kontrol
plane, pakai `logging: { type: "file", path: <lokal-atau-devnull>,
onAgentStreamEvent: (event) => kirimKeControlPlane(event) }` — ini yang harus
dipakai, bukan mode stdout.

---

## 5. Usage / cost

`IterationUsage` (`src/AgentProvider.ts:226-231`): `inputTokens`,
`cacheCreationInputTokens`, `cacheReadInputTokens`, `outputTokens` — murni
raw token count, terekspos per iterasi di `IterationResult.usage`
(`src/Orchestrator.ts:293-300`).

**Sumber berbeda per provider** — ini penting karena tidak seragam:
- **Claude Code**: diparse **pasca-hoc** dari session JSONL yang di-capture,
  lewat `provider.parseSessionUsage()` (`src/AgentProvider.ts:1238-1266`) —
  hanya jalan kalau `captureSessions && sessionStorage && sessionId &&
  bindMountHandle` terpenuhi (`src/Orchestrator.ts:507-511`), artinya **hanya
  bind-mount provider**, bukan isolated/no-sandbox.
- **Codex**: diparse **live dari stream**, event `turn.completed`
  (`src/AgentProvider.ts:681-697`, `:739-742`) — tidak butuh session capture.
- **Pi**: tidak ada `parseSessionUsage` sama sekali → `usage` selalu
  `undefined`.
- **Cursor/OpenCode/Copilot**: `captureSessions: false`, tidak ada
  `sessionStorage`, tidak ada usage parsing sama sekali.

**Tidak ada angka biaya (dollar) di mana pun.** Nama ADR-nya sendiri
menegaskan ini sebagai keputusan sadar:
`docs/adr/0005-usage-raw-tokens-no-percentage.md` — "raw tokens no
percentage". Tidak ada tabel harga model, tidak ada field currency. Sandcastle
juga **tidak menjumlahkan** usage lintas iterasi — `RunResult` tidak punya
total; caller harus reduce `iterations[].usage` sendiri. Satu-satunya agregasi
bawaan adalah string tampilan "Context window: NNNk"
(`src/run.ts:198-215`) — kemudahan UI, bukan API cost.

**Kesimpulan**: cost tracking bisa dibangun, tapi hanya dari raw token count
× tabel harga sendiri, dan granularitasnya bolong untuk Pi/Cursor/OpenCode/
Copilot serta untuk provider isolated/no-sandbox bahkan dengan Claude Code.

---

## 6. Sesi — capture, resume, lintas proses/mesin

`AgentSessionStorage` interface (`src/AgentProvider.ts:233-262`):
`captureToHost`, `resumeIntoSandbox`, `readHostSession`, `existsOnHost`,
`hostSessionFilePath`, `findByIdOnHost`.

**Lokasi penyimpanan = filesystem lokal mesin yang memanggil `run()`**, path
baku per-agent: Claude → `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`
(`src/SessionStore.ts:56-64`), Codex →
`~/.codex/sessions/YYYY/MM/DD/rollout-*-<id>.jsonl`
(`src/SessionStore.ts:234-259`), Pi →
`~/.pi/agent/sessions/--<encoded-cwd>--/` (`src/SessionStore.ts:304-355`).
Bisa dioverride ke path custom lewat opsi
`sessionStorage.hostProjectsDir`/`hostSessionsDir`, tapi tetap harus berupa
path filesystem yang bisa diakses proses itu.

`RunResult.resume()`/`.fork()` (`src/run.ts:805-839`) hanyalah pemanggilan
ulang `run({ ..., resumeSession: lastIteration.sessionId })` — closure ini
cuma syntactic sugar; caller **bisa** langsung panggil `run({resumeSession:
"<id>", ...})` dari proses/waktu lain **selama file JSONL masih ada di disk
lokal mesin itu**. `assertResumeSessionExists`
(`src/resumePrecheck.ts:22-59`) memvalidasi ini secara ketat sebelum
menjalankan agent — kalau file tidak ada, `run()` gagal cepat dengan pesan
jelas.

Transfer sesi host↔sandbox murni lewat `copyFileIn`/`copyFileOut` pada
`BindMountSandboxHandle` (`src/AgentProvider.ts:288-322`) — **tidak ada
transfer jaringan apa pun**. Isolated dan no-sandbox provider pada dasarnya
tidak dikabelkan untuk capture (`src/createSandbox.ts:281-284`, komentar
eksplisit).

### Bisakah sesi dilanjutkan di proses lain / mesin lain?

- **Proses lain, mesin sama**: **Ya**, trivial — `sessionId` adalah string,
  file JSONL persisten di disk, panggilan `run({resumeSession})` independen
  bisa terjadi kapan saja setelah itu selama file masih ada.
- **Mesin lain**: **Tidak didukung bawaan.** ADR
  `docs/adr/0016-resume-requires-filesystem-backed-sessions.md` secara
  eksplisit membatasi resume hanya untuk "file yang bisa disalin verbatim" —
  tidak ada cerita distribusi/remote sama sekali di ADR ini. Untuk kebutuhan
  "step berhenti tunggu manusia berjam-jam lalu lanjut di worker lain",
  control plane **harus** membangun sendiri: baca bytes JSONL lewat
  `readHostSession()`/`hostSessionFilePath()` (kedua fungsi ini memang
  diekspos justru untuk keperluan semacam ini), kirim ke worker tujuan, tulis
  ke direktori setara di worker itu (atau arahkan
  `sessionStorage.hostProjectsDir` ke lokasi yang sudah disinkronkan), baru
  panggil resume di sana. Bahan mentahnya tersedia; transport lintas mesinnya
  100% pekerjaan kita.

---

## 7. Lifecycle hooks

`SandboxHooks` (`src/SandboxLifecycle.ts:86-104`): tiga titik injeksi, semua
berupa **command shell string** (`{command, timeoutMs?, sudo?}`), bukan
callback JS:

- `host.onWorktreeReady[]` — jalan **di host**, setelah worktree dibuat +
  `copyToWorktree`, **sebelum** sandbox dibuat
  (`src/createSandbox.ts:943-949`, `src/createWorktree.ts:251-254`).
- `host.onSandboxReady[]` — jalan **di host**, setelah container up.
- `sandbox.onSandboxReady[]` — jalan **di dalam sandbox** lewat
  `provider.exec()`, dukung `sudo`.

`host.onSandboxReady` dan `sandbox.onSandboxReady` dijalankan **paralel**
(`Effect.all({concurrency: "unbounded"})`,
`src/SandboxLifecycle.ts:360-365`) — bukan berurutan, penting kalau kita
mengandalkan urutan antara sisi host dan sandbox. Tidak ada hook setelah
agent selesai selain nilai balik `RunResult` itu sendiri — tidak ada
`onRunComplete`. Tidak ada plugin API terstruktur; injeksi env variable ke
hook mengikuti env yang sudah di-resolve (§8), bukan mekanisme terpisah.

---

## 8. Secret — mekanisme `.sandcastle/.env`

Parser dotenv sederhana buatan sendiri (`src/EnvResolver.ts:5-47`) — dukung
quote ganda/tunggal dan escape `\n\r\t\\` di value ber-quote-ganda.
Precedence: `.sandcastle/.env` > `process.env`, tapi **hanya key yang
namanya muncul sebagai baris** di file itu yang di-resolve dari
`process.env` sebagai fallback (`src/EnvResolver.ts:56-73`, komentar eksplisit
"Only keys declared in .sandcastle/.env are resolved from process.env"). File
`.env` di root repo (bukan `.sandcastle/.env`) **sengaja tidak dibaca sama
sekali**.

Cara sampai ke agent: `mergeProviderEnv()` (`src/mergeProviderEnv.ts`)
menggabung `resolvedEnv` + `sandboxProviderEnv` + `agentProviderEnv` (key
tumpang tindih agent/sandbox → throw), lalu diteruskan sebagai env variable
biasa — `docker run -e KEY=VALUE` untuk docker provider, atau `env` object
`spawn()` untuk no-sandbox (`src/sandboxes/no-sandbox.ts:51,81`). Jadi
secret jadi bagian process environment container/proses, sama persis seperti
`docker -e` manual — terlihat oleh `docker inspect`/`ps` di mesin itu dan oleh
apa pun di dalam container yang membaca env.

**Redaksi log: TIDAK ADA sama sekali.** Grep menyeluruh `src/` untuk
`redact`/`mask` (case-insensitive) menghasilkan **nol match**. Tidak ada
mekanisme apa pun yang men-scrub nilai secret dari file log atau dari stream
`AgentStreamEvent`. Kalau tool call agent (mis. `Bash` dengan `echo $TOKEN`
atau perintah `curl` yang menaruh token di argumen) tertangkap oleh
`TOOL_ARG_FIELDS` (`src/AgentStreamEmitter.ts:44-49`), nilai itu mengalir
verbatim ke file log dan ke event `onAgentStreamEvent`. Ini **gap nyata**
untuk factory yang mengirim log ke tempat terpusat/UI bersama.

---

## 9. Struktur dan kesehatan repo

- **Single package**, bukan monorepo — tidak ada field `workspaces` di
  `package.json` root. `docs/` (Next.js/Fumadocs, `docs/package.json`,
  `private: true`, nama `sandcastle-docs`) adalah situs dokumentasi terpisah,
  tidak terhubung sebagai dependency code.
- `src/` flat, ~60 file non-test, **53 file `*.test.ts`** co-located di
  sebelah subjek masing-masing (bukan folder `tests/` terpisah) — sinyal
  kesehatan test yang wajar untuk ukuran repo ini (saya tidak menjalankan
  test suite / mengukur coverage %).
- Beberapa API internal ditandai eksplisit `@internal` di JSDoc — mis.
  `forkSession` di `RunOptions` (`src/run.ts:395-397`),
  `buildStructuredOutputRetryFeedback` (`src/run.ts:57`),
  `createSandboxFromWorktree` (`src/createSandbox.ts:732-736`). Batasan
  stabilitas riilnya adalah **apa yang diekspor `src/index.ts`** — simbol
  `@internal` ini tetap importable lewat path relatif tapi tidak masuk
  kontrak publik.
- **20 ADR** terdokumentasi (`docs/adr/0001` sampai `0020`) — sinyal proses
  desain yang matang; beberapa langsung relevan ke pertanyaan tim: `0003`
  (worktree reuse & fetch remote read-only), `0012`/`0016`/`0018` (semantik
  session resume/fork), `0019` (completion timeout untuk proses menggantung).
- **Git log**: clone ini shallow (`.git/shallow` ada, depth 1) sehingga
  jumlah commit total tidak bisa diverifikasi dari clone ini. `git log -1`:
  commit `e99f832`, "Merge pull request #832 from
  mattpocock/changeset-release/main — Version Packages",
  **2026-06-29 21:15:45 +0100**. `CHANGELOG.md` (71.6 KB) menunjukkan rilis
  versi berkelanjutan sampai 0.12.0 memakai Changesets — tanda maintenance
  aktif.
- **Lisensi**: MIT, Copyright (c) 2026 Matt Pocock (`LICENSE`).

---

## Daftar eksplisit: hal yang sandcastle TIDAK lakukan

Semua ini harus dibangun sendiri oleh control plane / lapisan di atas
sandcastle:

1. **Tidak pernah push ke git remote** — hanya fetch+ff-only-merge read-only
   pada reuse strategi `branch`. "Git remote sebagai bus antar mesin" adalah
   100% custom wrapper (push manual setelah `run()` selesai, checkout/fetch
   manual sebelum `run()` dimulai).
2. **Tidak ada entry point clone-dari-remote** — `cwd` wajib checkout lokal
   yang sudah hidup di mesin worker itu.
3. **Tidak ada transfer sesi lintas mesin** — session JSONL cuma di disk
   lokal pemanggil; resume di worker lain butuh kita menyalin bytes sendiri
   lewat `readHostSession()`/`hostSessionFilePath()`.
4. **Tidak ada cost/dollar tracking** — hanya raw token count, dan hanya
   untuk Claude Code (post-hoc) & Codex (live); Pi/Cursor/OpenCode/Copilot
   tidak punya usage sama sekali.
5. **Tidak ada redaksi secret** di log/stream mana pun — plaintext env value
   bisa bocor lewat tool-call echo.
6. **Tidak ada hook JS terstruktur** — hook lifecycle hanya shell command
   string, dieksekusi host/sandbox, tanpa callback tipe apa pun (kecuali
   observability stream).
7. **Tidak ada resolusi konflik merge** — konflik menghentikan run dengan
   instruksi manual, tidak ada retry/auto-resolve.
8. **Tidak ada queue/scheduling/worker-registration/auth** — sandcastle
   murni library fungsi + CLI lokal; seluruh lapisan "worker menarik kerja
   dari control plane" ada di luar cakupannya sama sekali (memang wajar,
   tapi perlu ditegaskan karena ini inti dari "distributed software
   factory").
9. **Tidak ada server API/HTTP** — dipakai dengan `import` langsung ke proses
   Node worker, bukan dipanggil lewat service terpisah.
10. **Tidak ada batasan ukuran output di jalur live-stream** — `BoundedTail`
    hanya membatasi `ExecResult.stdout/stderr` yang dikembalikan di akhir,
    bukan volume event `onLine`/`onAgentStreamEvent` yang mengalir live;
    kalau ini diteruskan ke log store bersama, backpressure/cap harus kita
    yang pasang.

---

## Penilaian

**Layak dipakai sebagai dependency, bukan di-fork.**

Alasan berbasis kode:

- Interface provider (`src/SandboxProvider.ts`) benar-benar dekopel dari
  Docker/Podman — dikonfirmasi dengan grep langsung: nol referensi "docker"
  fungsional di `SandboxFactory.ts`, `SandboxLifecycle.ts`, `Orchestrator.ts`,
  `createSandbox.ts`, `createWorktree.ts`. Menulis provider custom untuk
  worker kita (mis. exec ke proses lokal worker, atau ke sandbox milik
  infrastruktur sendiri) adalah kerja kecil (~6 method), bukan alasan untuk
  fork.
- Kontrak streaming (`onLine` wajib per-baris, didokumentasikan 3x sebagai
  syarat keras) langsung memenuhi kebutuhan mutlak "log bisa di-tail live" —
  tidak perlu modifikasi apa pun di sandcastle untuk itu.
- Semua tiga entry point (`run`/`createSandbox`/`createWorktree`) sudah
  100% runtime-argument-driven — cocok persis dengan model "control plane
  kirim prompt/repo/branch/agent lewat pesan ke worker", tanpa perlu
  menulis file config apa pun di worker sebelum eksekusi.
- Repo aktif dipelihara (changeset rilis berkelanjutan sampai 0.12.0, 20 ADR
  terdokumentasi, commit terakhir per Juni 2026), MIT license — risiko fork
  (harus ikut merge upstream breaking change pre-1.0 sendiri, per ADR 0003)
  lebih mahal daripada menulis wrapper tipis di atasnya.

Gap-gap di atas (§ Daftar eksplisit) semuanya bersifat **aditif** —
"tambahkan lapisan", bukan "ubah inti sandcastle". Cross-machine session
transfer, redaksi secret, cost normalization, dan git-remote-as-bus semuanya
bisa dibangun sebagai kode di sisi control plane/worker kita yang memanggil
`readHostSession()`, `onAgentStreamEvent`, dan `git push` biasa dari luar —
tidak satu pun butuh mengubah source sandcastle. Itu argumen kuat untuk
"dependency", bukan "fork": kalau kita fork, kita mewarisi beban maintenance
proyek yang sedang aktif berkembang, padahal semua yang kita butuh tambahkan
bisa hidup sepenuhnya di luar boundary-nya.

Satu peringatan: kalau kebutuhan resume-lintas-mesin ternyata jadi fitur inti
(bukan edge case), pertimbangkan menulis `AgentSessionStorage` kita sendiri
per provider (interface-nya sudah diekspor,
`src/AgentProvider.ts:233-262`) yang backend-nya object storage bersama,
bukan bergantung pada baca/tulis file lokal manual — ini masih pemakaian
API publik yang didukung (`sessionStorage.hostProjectsDir` dsb bisa diarahkan
ke mount point bersama), bukan fork.
