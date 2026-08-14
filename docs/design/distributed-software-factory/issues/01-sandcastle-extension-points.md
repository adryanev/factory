# Permukaan API dan titik ekstensi sandcastle

Type: research
Status: resolved
Blocked by: —

## Question

Apa yang sandcastle berikan secara cuma-cuma, dan di mana batasnya, kalau ia dipakai sebagai mesin eksekusi satu step di dalam worker yang dikendalikan control plane jarak jauh?

Baca source di https://github.com/mattpocock/sandcastle dan jawab dengan bukti dari kode, bukan dari README saja:

1. **Permukaan API publik** — tanda tangan `run()`, `createSandbox()`, `createWorktree()`. Apa yang bisa ditentukan saat pemanggilan versus apa yang harus ada di file konfigurasi di disk? Bisakah prompt, repo, branch, dan pilihan agent semuanya datang dari argumen runtime (dikirim control plane) tanpa menulis file konfigurasi lebih dulu?
2. **Branch strategy** — mekanik persis `head`, `merge-to-head`, dan `branch`. Apakah `branch` bisa push ke remote, atau hanya commit lokal? Bagaimana konflik ditangani? Ini menentukan apakah "git remote jadi bus" bisa dibangun di atas API yang ada atau butuh pembungkus sendiri.
3. **Provider** — kontrak interface untuk provider bind-mount dan isolated. Apa persisnya yang harus diimplementasikan sebuah provider kustom? Berapa dalam asumsi Docker/Podman tertanam di core?
4. **Log dan progres** — bagaimana output agent keluar dari sandbox. Stream, callback, event emitter, atau hanya string di akhir? Bisakah log di-tail secara live selagi agent berjalan (syarat mutlak untuk monitoring di UI)?
5. **Usage / cost** — apakah ada token count, biaya, atau metadata usage yang diekspos per run? Jawaban ini yang menentukan apakah cost tracking bisa dilakukan sama sekali.
6. **Sesi** — bagaimana session capture/resume disimpan. Bisakah sesi dilanjutkan di proses lain, atau bahkan mesin lain?
7. **Lifecycle hooks** — hook mana yang berjalan di host dan mana di dalam sandbox. Apa yang bisa disuntikkan lewat hook.
8. **Secret** — mekanisme `.sandcastle/.env`. Bagaimana variabel sampai ke agent di dalam container, dan apakah ada redaksi (redaction) bawaan pada log.
9. **Struktur repo** — apakah ini satu paket atau monorepo, seberapa aktif, apakah ada API internal yang jelas tidak stabil.

Keluaran: `docs/design/distributed-software-factory/research/sandcastle-api.md`, dengan tautan ke file dan baris yang jadi dasar tiap temuan, ditutup daftar eksplisit **hal yang sandcastle tidak lakukan** yang harus kita bangun sendiri.

## Answer

Laporan lengkap dengan sitasi file:baris: [`research/sandcastle-api.md`](../research/sandcastle-api.md).

**Layak dipakai sebagai dependency. Tidak perlu fork.** Semua kesenjangan bersifat aditif — bisa dibangun sebagai wrapper di luar sandcastle tanpa mengubah source-nya.

Yang didapat cuma-cuma:

- **API sepenuhnya runtime-argument-driven.** `run()`, `createSandbox()`, `createWorktree()` menerima prompt inline, cwd, branch, dan agent factory sebagai argumen — tanpa file konfigurasi. Satu-satunya file yang dibaca adalah `.sandcastle/.env`, dan itu opsional. Artinya control plane bisa mengirim seluruh definisi step sebagai payload; worker tidak perlu menulis file dulu.
- **Provider benar-benar dekopel dari Docker.** Interface bind-mount/isolated/no-sandbox di `src/SandboxProvider.ts` tidak punya referensi fungsional ke Docker di core. Provider kustom adalah kerja kecil. `exec()` wajib streaming per baris — didokumentasikan tiga kali sebagai syarat keras.
- **Live log tail.** Lewat file `tail -f` atau callback `onAgentStreamEvent` real-time (hanya pada mode logging `type: "file"`, bukan `"stdout"`). Ini jalur yang harus dipakai worker untuk meneruskan log ke UI.
- Single package, MIT, aktif — rilis sampai 0.12.0, 20 ADR, 53 file test, commit terakhir 2026-06-29.

Yang **tidak** dilakukan sandcastle dan harus kita bangun:

1. **Push ke git remote.** Branch strategy hanya bekerja lokal: `head` bind-mount langsung, `merge-to-head` melakukan `git merge` lokal di host (`src/SandboxLifecycle.ts:439-483`), `branch` meninggalkan commit di branch itu. Grep menyeluruh untuk push: nol hasil. Satu-satunya kontak remote adalah fetch + ff-only merge read-only saat worktree dipakai ulang (ADR 0003). **Keputusan "git remote jadi bus" di Notes tidak gratis dari sandcastle** — transportnya kita yang bangun.
2. **Resume sesi lintas mesin.** Lintas proses di mesin yang sama trivial (JSONL lokal); lintas mesin tidak didukung (ADR 0016). `readHostSession()` dan `hostSessionFilePath()` diekspos justru untuk membangun transport sendiri. Ini prasyarat untuk step HITL yang di-suspend lalu dilanjutkan di worker lain — lihat ticket 14.
3. **Redaksi log.** Tidak ada sama sekali; grep `redact`/`mask` nol hasil. Secret bisa bocor lewat echo tool-call. Beban ini jatuh ke ticket 10.
4. **Cost dalam mata uang.** Hanya token mentah, tanpa dolar (ADR 0005, disengaja). Cakupannya bolong: hanya Claude Code (post-hoc) dan Codex (live) yang melaporkan usage; Pi, Cursor, OpenCode, dan Copilot tidak melaporkan apa pun. Ini membatasi apa yang bisa dijanjikan cost tracking.
5. **Resolusi konflik.** Konflik merge menggagalkan run dan mengeluarkan instruksi manual. Tidak ada auto-resolve — relevan untuk step join di ticket 06.

Catatan bentuk: hook adalah string perintah shell di host atau sandbox, bukan callback JS. `host.onSandboxReady` dan `sandbox.onSandboxReady` berjalan **paralel**, bukan berurutan.

Konsekuensi ke ticket lain: 12 (jawabannya condong ke *dependency*, tinggal dikonfirmasi setelah 00 selesai), 06 (konflik join), 10 (redaksi), 14 (transport sesi lintas mesin), dan kabut cost tracking (cakupannya terbatas pada dua agent).
