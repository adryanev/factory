# Gambar di jalur prompt — apakah `startTurn(spec)` bisa membawa gambar?

Riset untuk issue [#115](https://github.com/adryanev/factory/issues/115) (bagian dari #114).

**Jawaban singkat.** Tidak. Di `@ai-hero/sandcastle` 0.12.0 jalur prompt adalah
`string` murni dari ujung ke ujung — tidak ada satupun field untuk gambar,
lampiran, atau base64. Tapi keempat agent CLI yang relevan (Claude Code, Codex,
OpenCode, pi) **semuanya** bisa membaca gambar dari **path berkas di working
directory** lewat tool bacanya sendiri, dan tiga di antaranya punya flag
lampiran native yang sandcastle tidak pernah kirim. Jadi gambar sampai ke model
lewat *isi disk Sandbox*, bukan lewat isi prompt. Premis netralitas alat
selamat; premis "gambar masuk lewat Question/Answer" harus dibaca ulang sebagai
"gambar ditulis ke disk, prompt hanya membawa path-nya".

Dan `pi` **didukung penuh** oleh sandcastle 0.12.0 — catatan peta DSF yang
menyebut daftar Claude Code, Codex, Cursor, OpenCode, Copilot itu **kurang satu
entri**. Tidak ada lubang di premis netralitas alat dari sisi ini.

---

## 0. Metode dan batas riset

Semua klaim di bawah berasal dari source code atau output `--help` biner yang
terpasang, bukan dari ingatan.

- **Sandcastle 0.12.0**: paket npm terpasang di
  `node_modules/.pnpm/@ai-hero+sandcastle@0.12.0/node_modules/@ai-hero/sandcastle/`
  hanya berisi `dist/` (build) dan `README.md` — tidak ada `src/`. Source TypeScript
  asli diekstrak dari `sourcesContent` di dalam `dist/*.js.map` (44 berkas, semua
  `src/*.ts`). Penomoran baris di bawah merujuk ke source hasil ekstraksi itu —
  yaitu source yang menghasilkan build 0.12.0 yang dipublikasikan ke npm.
  Bahwa ia identik dengan tag 0.12.0 di `github.com/mattpocock/sandcastle`
  adalah **inference**; saya tidak memeriksa tag itu. Salinan kerja:
  `<scratchpad>/sc-src/src/`.
- **Agent CLI**: diuji pada versi yang terpasang di mesin ini —
  `claude` 2.1.232, `codex-cli` 0.147.0, `opencode` 1.18.15. `pi` tidak
  terpasang; source-nya diambil dari tarball npm
  `@mariozechner/pi-coding-agent@0.73.1` (versi yang persis disebut komentar
  sandcastle di `src/AgentProvider.ts:553`).
- **Versi CLI di sandbox ≠ versi di mesin ini.** Dockerfile template sandcastle
  memasang versi `latest` saat image dibangun (lihat §4). Temuan per-CLI di
  bawah berlaku untuk versi yang diuji; anggap sebagai *lower bound*.

Yang **tidak** bisa saya pastikan, dan kenapa:

1. **Codex `view_image` end-to-end.** Akun ChatGPT di mesin ini menolak semua
   model yang saya coba (`gpt-5.6-sol`, `gpt-5.1-codex`, `gpt-5.1-codex-max`)
   dengan `400 invalid_request_error: model is not supported when using Codex
   with a ChatGPT account`. Bukti untuk Codex karenanya berasal dari string
   tool-definition di dalam biner 0.147.0, bukan dari giliran yang benar-benar
   jalan.
2. **OpenCode `read` end-to-end.** Tool `read`-nya jelas mendukung gambar
   (§3.3), tapi satu-satunya provider yang ter-auth di mesin ini (OpenCode Go)
   tidak punya model vision — dua model yang saya coba membalas literal
   `ERROR: Cannot read image (this model does not support image input)`.
   Sisi OpenCode terbukti; sisi model tidak bisa saya buktikan di sini.
3. **Ukuran maksimum gambar** yang diterima tiap CLI sebelum ditolak atau
   di-resize. Tidak diselidiki.

---

## 1. Sandcastle 0.12.0: jalur prompt tidak membawa gambar

### 1.1 `prompt` adalah `string`, dari `run()` sampai `stdin` proses anak

Tiga titik, semuanya `string`:

```ts
// src/run.ts:347-356
/** Inline prompt string (mutually exclusive with promptFile) */
readonly prompt?: string;
/** Path to a prompt file (mutually exclusive with prompt). */
readonly promptFile?: string;
```

```ts
// src/PromptResolver.ts:18-21
export interface ResolvedPrompt {
  readonly text: string;
  readonly source: "inline" | "template";
}
```

```ts
// src/AgentProvider.ts:203-215
export interface AgentCommandOptions {
  readonly prompt: string;
  readonly dangerouslySkipPermissions: boolean;
  readonly resumeSession?: string;
  readonly forkSession?: boolean;
}
```

Hasil akhirnya juga `string`:

```ts
// src/AgentProvider.ts:220-223
export interface PrintCommand {
  readonly command: string;
  readonly stdin?: string;
}
```

**Verified.** Tidak ada `image`, `attachment`, `media`, `base64`, `mimeType`,
atau field sejenis di seluruh `RunOptions` (`src/run.ts:332-427`),
`AgentCommandOptions`, `PrintCommand`, maupun di 48 KB `dist/index.d.ts` —
satu-satunya kemunculan kata "image" di sana adalah `docker({ imageName: ... })`
(`dist/index.d.ts:505`, `:717`, `:994`), yaitu nama container image.

### 1.2 Preprocessor prompt juga murni teks

Satu-satunya transformasi prompt sebelum dikirim adalah ekspansi shell
`` !`command` `` dan substitusi `{{KEY}}`. Ekspansi shell mengganti pola dengan
`execResult.stdout.trimEnd()` — sebuah `string`:

```ts
// src/PromptPreprocessor.ts:75
return execResult.stdout.trimEnd();
```

Artinya walaupun kita menulis `` !`base64 gambar.png` `` di prompt template,
yang masuk adalah teks base64 mentah di dalam badan prompt user — bukan sebuah
image content block. Model akan melihatnya sebagai deretan karakter, bukan
gambar. (**Inference**, tapi konsekuensi langsung dari tipe `string`: tidak ada
tempat di protokol CLI manapun untuk menandai potongan teks itu sebagai media.)

### 1.3 Perintah persis yang dibangun tiap provider — dan flag gambar yang hilang

| Provider | Perintah print-mode yang dibangun sandcastle 0.12.0 | Prompt lewat | Flag gambar CLI yang **tidak** dikirim |
|---|---|---|---|
| `claudeCode` | `claude --print --verbose … --output-format stream-json --model <m> … -p -` (`src/AgentProvider.ts:1213`) | stdin | `--input-format stream-json` |
| `codex` | `codex exec --json --dangerously-bypass-approvals-and-sandbox -m <m>` (`src/AgentProvider.ts:811`) | stdin | `-i, --image <FILE>...` |
| `pi` | `pi -p --mode json --model <m>` (`src/AgentProvider.ts:651`) | stdin | argumen `@file.png` di argv |
| `opencode` | `opencode run --format json --model <m> … <prompt>` (`src/AgentProvider.ts:981`) | argv | `-f, --file <path>` |
| `cursor` | `agent --print --output-format stream-json --model <m> … <prompt>` (`src/AgentProvider.ts:856`) | argv | tidak diselidiki |
| `copilot` | `copilot -p <prompt> --output-format json --model <m>` (`src/AgentProvider.ts:1131`) | argv | tidak diselidiki |

**Verified.** Setiap flag di kolom terakhir ada di CLI-nya (§3) tapi tidak
pernah muncul di string perintah yang dibangun sandcastle. Untuk memakainya
kita harus menulis `AgentProvider` sendiri — antarmuka `AgentProvider`
(`src/AgentProvider.ts:264-277`) memang publik dan diekspor, jadi ini mungkin,
tapi berarti kita fork perilaku provider bawaan dan menanggung sendiri
kompatibilitasnya lintas versi.

---

## 2. Yang bisa dikirim ke Sandbox: berkas, bukan gambar-di-prompt

Ada **dua** jalur berbeda untuk menaruh berkas di dalam Sandbox, dengan
konsekuensi commit yang berbeda. Perbedaan ini yang penting untuk desain.

### 2.1 `copyToWorktree` — masuk ke dalam repo worktree (berisiko ter-commit)

```ts
// src/run.ts (RunOptions)
/** Paths relative to the host repo root to copy into the worktree before sandbox start. */
readonly copyToWorktree?: string[];
```

Implementasinya menyalin dari root repo host ke root worktree, dengan
copy-on-write bila filesystem mendukung:

```ts
// src/CopyToWorktree.ts:36-42
const src = join(hostRepoDir, relativePath);
if (!existsSync(src)) { continue; }
const dest = join(worktreePath, relativePath);
… execFile("cp", [...cowFlags, src, dest], …)
```

**Verified.** Path relatif terhadap root repo → berkas mendarat **di dalam**
pohon kerja git.

### 2.2 `handle.copyFileIn` — bisa ke path manapun (aman dari commit)

```ts
// src/SandboxProvider.ts:59-61
copyFileIn(hostPath: string, sandboxPath: string): Promise<void>;
copyFileOut(sandboxPath: string, hostPath: string): Promise<void>;
```

`sandboxPath` absolut dan bebas — misalnya `/tmp/lampiran/uji.png`. Sandcastle
sendiri memakai jalur ini untuk memindahkan session JSONL ke
`/home/agent/.claude/projects/…` (`src/AgentProvider.ts:305-322`), di luar
worktree. **Verified.**

### 2.3 Apakah gambar ikut ter-commit ke Branch?

Sandcastle **tidak pernah** menjalankan `git add` atau `git commit` sendiri —
pencarian `git commit` di seluruh 44 berkas source tidak menghasilkan apa-apa.
Commit hanya dibuat oleh agent. **Verified.**

Tapi sandcastle **memang mengangkut berkas untracked keluar dari Sandbox**:

```ts
// src/syncOut.ts:11-14 (komentar header)
 * Three-prong extraction within each phase:
 * 1. Committed changes: `git format-patch` + `git am --3way`
 * 2. Uncommitted changes (staged + unstaged): `git diff HEAD` + `git apply`
 * 3. Untracked files: `git ls-files --others` + `copyFileOut` each file
```

```ts
// src/syncOut.ts:259-265
const lsFilesResult = yield* execSandbox(
  handle, "git ls-files --others --exclude-standard", { cwd: worktreePath },
);
```

**Verified.** Jadi gambar yang ditulis ke dalam worktree akan:

1. terbawa keluar ke host lewat sync-out sebagai untracked file, dan
2. ikut ter-commit ke Branch **kalau** agent menjalankan `git add -A` /
   `git add .` — yang merupakan pola sangat lazim di prompt "commit hasil
   kerjamu".

Risikonya nyata. Tiga mitigasi, dari yang paling aman:

1. **Tulis gambar di luar worktree** (`/tmp/attachments/…` lewat `copyFileIn`),
   lalu prompt merujuk path absolut itu. Tidak terlihat oleh git sama sekali.
   `--exclude-standard` maupun `git add -A` tidak menjangkaunya.
2. Tulis di dalam worktree tapi di direktori yang di-`.gitignore`. `git
   ls-files --others --exclude-standard` menghormati gitignore, jadi sync-out
   juga melewatkannya. Tapi `git add -f` atau gitignore yang salah tetap bisa
   membocorkannya.
3. Tulis apa adanya dan bersihkan setelah giliran. Paling rapuh — kalau agent
   commit duluan, sudah terlambat.

**Rekomendasi: opsi 1.** Ia satu-satunya yang tidak bergantung pada disiplin
prompt agent.

Catatan: opsi 1 **tidak** kompatibel dengan `copyToWorktree`, yang menurut
definisinya menulis ke dalam worktree. Untuk opsi 1 kita perlu
`handle.copyFileIn` — yang berarti hook `onSandboxReady` atau akses langsung ke
`BindMountSandboxHandle`, bukan opsi `run()`. (**Inference** dari §2.1–2.2;
belum saya coba jalankan.)

---

## 3. Alat mana yang menerima gambar, dan lewat bentuk apa

Ringkasan:

| CLI | Path berkas di prompt (tool baca) | Flag lampiran native | Base64 di prompt | Dipakai sandcastle 0.12.0? |
|---|---|---|---|---|
| Claude Code 2.1.232 | **Ya — terbukti empiris** | `--input-format stream-json` (base64 di stdin) | via stream-json saja | tool baca: ya. flag: tidak |
| Codex 0.147.0 | Ya (tool `view_image`) | `-i, --image <FILE>...` di `codex exec` | tidak | tool baca: ya. flag: tidak |
| OpenCode 1.18.15 | Ya (tool `read`) | `-f, --file <paths>` di `opencode run` | tidak | tool baca: ya. flag: tidak |
| pi 0.73.1 | Ya (tool `read`) | argumen `@file.png` di argv | tidak | tool baca: ya. `@file`: tidak |

"Dipakai sandcastle" = jalur itu tetap tersedia tanpa mengubah apa pun, karena
tool baca adalah milik agent dan bekerja di dalam giliran, terlepas dari
perintah yang dibangun sandcastle.

### 3.1 Claude Code 2.1.232 — terbukti empiris

Ini satu-satunya yang berhasil saya jalankan end-to-end.

Uji: PNG 700×220 berisi teks `ZEBRA-4471` (dibuat dengan ImageMagick, kata
sandi acak yang mustahil ditebak model). Perintah **persis** bentuk yang
dibangun sandcastle (`src/AgentProvider.ts:1213`):

```
printf '<prompt>' | claude --print --verbose --dangerously-skip-permissions \
  --output-format stream-json --model claude-haiku-4-5-20251001 -p -
```

Prompt: *"Gunakan tool Read pada berkas ./uji.png. Sebutkan persis teks yang
tertulis di dalam gambar itu."*

Hasil: stream stdout berisi satu blok `"type":"image"` (tool result Read berupa
base64 image block), dan jawaban akhir model menyebut `ZEBRA-4471` dengan
benar. **Verified.**

Kesimpulan: **tool `Read` milik Claude Code merender gambar menjadi image
content block, dan itu bekerja di print mode dengan perintah sandcastle apa
adanya.** Prompt hanya perlu membawa path.

Jalur base64 alternatif ada tapi tidak terjangkau: `--input-format` didokumentasikan
sebagai *"Specify input format for print mode (options: `text`, `stream-json`)"*
(<https://code.claude.com/docs/en/cli-reference>; `claude --help` 2.1.232
menyebutnya *"Input format (only works with --print): 'text' (default), or
'stream-json' (realtime streaming input)"*). Sandcastle tidak mengirim flag ini,
jadi stdin selalu ditafsirkan sebagai teks.

### 3.2 Codex 0.147.0 — dua jalur, keduanya ada di biner

**Flag lampiran.** `codex exec --help` (v0.147.0):

```
  -i, --image <FILE>...
          Optional image(s) to attach to the initial prompt
```

**Verified**, tapi sandcastle tidak pernah mengirimnya
(`src/AgentProvider.ts:782-814`).

**Tool baca gambar.** Biner `/opt/homebrew/Caskroom/codex/0.147.0/bin/codex`
berisi definisi tool berikut (diambil dengan `strings`):

> `view_image` — *"View a local image file from the filesystem when visual
> inspection is needed. Use this for images already available on disk."*
> Parameter: *"Local filesystem path to an image file."* Ada juga parameter
> `detail` (*"Image detail level. Defaults to `high`; use `original` to
> preserve exact resolution."*)

Biner juga menyebut path source `core/src/tools/handlers/view_image.rs`, feature
flag bernama `view_image`, event `view_image_tool_call`, dan dua pesan galat:
*"view_image is not allowed because you do not support image inputs"* dan
*"view_image is unavailable in this session"*.

**Verified** bahwa tool-nya ada di 0.147.0 dan menerima path lokal.
**Tidak terverifikasi** end-to-end (lihat §0). Dua gerbang yang harus terbuka:
feature flag `view_image` aktif, dan model mendukung input gambar.

### 3.3 OpenCode 1.18.15 — tool `read` mendukung gambar, terhalang model

**Flag lampiran.** `opencode run --help` (v1.18.15):

```
  -f, --file    file(s) to attach to message    [array]
```

**Verified**; sandcastle tidak mengirimnya (`src/AgentProvider.ts:967-983`).

**Tool baca gambar.** Uji langsung, prompt: *"Jangan gunakan tool bash sama
sekali. Gunakan HANYA tool read pada berkas ./uji.png, lalu laporkan apa
persisnya yang dikembalikan tool read itu."* Event JSON yang keluar:

```json
{"tool":"read","state":{"status":"completed","output":"Image read successfully"}}
```

dan model menjawab:

> Tool `read` pada `./uji.png` mengembalikan: `Image read successfully`, tapi
> lampiran media yang menyertainya berisi error: **"ERROR: Cannot read image
> (this model does not support image input)."**

**Verified**: OpenCode mengenali PNG, memperlakukannya sebagai gambar, dan
melampirkan media. Kegagalan murni di sisi model (`deepseek-v4-flash`, lalu
`opencode/big-pickle` — keduanya bukan model vision; hanya provider "OpenCode
Go" yang ter-auth di mesin ini).

Catatan menarik dari uji pertama tanpa larangan bash: OpenCode **memecahkan
masalahnya sendiri** dengan menulis skrip Swift ber-Vision framework dan
menjalankan OCR lewat bash, lalu melaporkan `ZEBRA-4471` dengan benar. Ini
bukan dukungan gambar — ini agent yang cerdik. Jangan diandalkan: bergantung
pada OS dan toolchain di dalam image sandbox (Linux, bukan macOS).

### 3.4 pi 0.73.1 — tool `read` mendukung gambar; `@file` tidak terjangkau dari stdin

**Tool baca gambar.** Deskripsi tool `read` di
`dist/core/tools/read.js:138` (tarball npm):

> *"Read the contents of a file. Supports text files and images (jpg, png, gif,
> webp). Images are sent as attachments."*

Ada juga penanganan model non-vision yang eksplisit
(`dist/core/tools/read.js:47-51`):

```js
function getNonVisionImageNote(model) {
    if (!model || model.input.includes("image")) { return undefined; }
    return "[Current model does not support images. The image will be omitted from this request.]";
}
```

**Verified.** Jalur path-di-prompt bekerja untuk pi, dengan gerbang yang sama:
model harus mendukung gambar.

**Jalur `@file` tidak terjangkau lewat sandcastle.** README pi menunjukkan
`pi -p @screenshot.png "What's in this image?"` (README.md:587). Tapi `@file`
diurai dari **argv**, bukan dari stdin:

```js
// dist/cli/args.js:150
result.fileArgs.push(arg.slice(1)); // Remove @ prefix
```

```js
// dist/main.js:90-93
async function prepareInitialMessage(parsed, autoResizeImages, stdinContent) {
    if (parsed.fileArgs.length === 0) {
        return buildInitialMessage({ parsed, stdinContent });
    }
```

dan `stdinContent` digabung sebagai teks polos, sementara gambar hanya bisa
datang dari `fileImages` (yaitu dari `fileArgs`):

```js
// dist/cli/initial-message.js:5-20
export function buildInitialMessage({ parsed, fileText, fileImages, stdinContent }) {
    const parts = [];
    if (stdinContent !== undefined) { parts.push(stdinContent); }
    …
    return {
        initialMessage: parts.length > 0 ? parts.join("") : undefined,
        initialImages: fileImages && fileImages.length > 0 ? fileImages : undefined,
    };
}
```

Sandcastle mengirim prompt pi **lewat stdin** (`src/AgentProvider.ts:650-653`)
dan tidak pernah menaruh pesan di argv. **Verified**: menulis `@gambar.png` di
dalam prompt tidak akan diekspansi — ia sampai ke model sebagai teks harfiah
`@gambar.png`.

---

## 4. `pi` didukung penuh oleh sandcastle 0.12.0

Catatan peta DSF menyebut daftar alat sandcastle sebagai Claude Code, Codex,
Cursor, OpenCode, Copilot — tanpa pi. **Daftar itu salah untuk 0.12.0.** Bukti,
tiga lapis:

1. **Factory function.** `export const pi = (model, options?) => ({ name: "pi", … })`
   di `src/AgentProvider.ts:628-665`, lengkap dengan `PiOptions`
   (`:613-626`), parser stream `parsePiStreamLine` (`:546-611`), dan
   session storage `makePiSessionStorage` (`:495-544`).
2. **Didokumentasikan.** README 0.12.0 baris 836 mendaftarkan
   `pi("claude-sonnet-4-6")` bersebelahan dengan `claudeCode`, `codex`,
   `cursor`, `opencode`, `copilot`. Baris 891: *"Session capture is enabled by
   default for `claudeCode()`, `codex()`, and `pi()`"* — pi bahkan termasuk
   golongan yang **resumable**, bersama Claude Code dan Codex; cursor,
   opencode, dan copilot tidak (`src/AgentProvider.ts:843-847`, `:965`,
   `:1115-1122`).
3. **Ada Dockerfile template-nya.** `sandcastle init` menawarkan pi sebagai
   entri kedua di `AGENT_REGISTRY` (`src/InitService.ts:424-432`) dan menulis
   Dockerfile yang menjalankan `RUN npm install -g @mariozechner/pi-coding-agent`
   (`src/InitService.ts:263`).

Registry lengkapnya enam: `claude-code`, `pi`, `codex`, `cursor`, `opencode`,
`copilot` (`src/InitService.ts:409-470`). **Verified.**

Konsekuensi: premis netralitas alat di peta DSF tidak punya lubang di sisi pi.
Yang perlu diperbaiki hanyalah catatannya.

---

## 5. Konsekuensi untuk desain

### 5.1 Bentuk lampiran gambar di `Question`/`Answer`

Yang harus dibawa `Question`/`Answer` adalah **referensi ke blob**, bukan
gambarnya. Bentuk yang cocok dengan kenyataan di atas:

- `Answer` menyimpan daftar lampiran: `{ blobId, filename, mimeType, sizeBytes }`.
- Sebelum `startTurn(spec)`, worker menulis tiap lampiran ke disk Sandbox lewat
  `handle.copyFileIn` ke direktori **di luar worktree** (mis.
  `/tmp/sandcastle-attachments/<turnId>/<filename>`).
- `spec.prompt` merender path absolut itu ke dalam teks, dengan instruksi
  eksplisit "buka berkas ini". Semua empat CLI punya tool baca yang menangani
  path lokal.

Ini seragam lintas alat, tidak butuh flag khusus per-CLI, dan tidak menyentuh
git.

### 5.2 Apakah derivasi gambar-jadi-teks perlu ada?

> **Koreksi.** Versi pertama section ini menyebut gambar "dijatuhkan **secara
> senyap**" oleh model non-vision. Itu **terlalu kuat dan salah**. Section 6
> menelusuri kodenya: ketiga alat menyisipkan catatan teks in-band, jadi
> **model diberi tahu**. Yang senyap adalah lapisan di atasnya — orkestrator.
> Rekomendasi di bawah tidak berubah; alasannya yang berubah. Rincian di §6.2.

**Ya, tapi sebagai fallback, bukan jalur utama.** Alasannya bukan sandcastle —
melainkan **model**. Tiga dari empat CLI (Codex, OpenCode, pi) memeriksa
kemampuan vision model dan mengganti gambar dengan catatan teks bila model
tidak mendukungnya (`view_image is not allowed because you do not support image
inputs`; `ERROR: Cannot read … (this model does not support image input).
Inform the user.`; `[Current model does not support images. The image will be
omitted from this request.]`). Step yang dikonfigurasi dengan model non-vision
tetap **exit 0**, tanpa event terstruktur apa pun, dan sandcastle tidak
mengekstrak catatan itu — jadi dari sudut pandang orkestrator hasilnya terlihat
wajar (§6.2).

Maka:

- Simpan deskripsi teks (alt text atau hasil derivasi) berdampingan dengan
  blob, dan sertakan **selalu** di dalam prompt. Kalau model vision, ia dapat
  keduanya; kalau tidak, ia tetap dapat sesuatu.
- Tentukan kemampuan vision di control plane **sebelum** giliran, dari daftar
  kapabilitas yang bisa dibaca mesin (§6.4) — jangan andalkan agent memilih
  untuk merelai catatan itu. Hanya OpenCode yang secara eksplisit
  memerintahkannya (`Inform the user.`).

### 5.3 Jangan andalkan flag native per-CLI

Godaannya adalah mengirim `-i`, `-f`, atau `@file` per-provider agar gambar
masuk sebagai bagian dari pesan pertama, bukan sebagai tool call. Tiga
keberatan:

1. Butuh `AgentProvider` custom per alat — enam implementasi untuk menggantikan
   satu jalur path-di-prompt yang sudah seragam. Melanggar netralitas alat yang
   justru jadi premis peta.
2. Bentuknya berbeda-beda (argv vs stdin vs sintaks `@`) dan sudah terbukti
   rapuh: pi hanya menerima `@file` dari argv, sementara sandcastle mengirim
   prompt lewat stdin.
3. Tidak memberi apa pun yang tidak diberi jalur berkas — model tetap butuh
   dukungan vision, dan gambar tetap harus ada di disk Sandbox lebih dulu.

### 5.4 Temuan sampingan (di luar lingkup, tapi menyentuh seam yang sama)

Sandcastle 0.12.0 membangun perintah OpenCode dengan
`--dangerously-skip-permissions` (`src/AgentProvider.ts:977-979`). Flag itu
**tidak ada** di `opencode run --help` pada opencode 1.18.15 — yang ada adalah
`--auto` (*"auto-approve permissions that are not explicitly denied
(dangerous!)"*). Kemungkinan flag itu dihapus/di-rename di OpenCode setelah
sandcastle 0.12.0 dirilis. Belum saya uji apakah opencode mengabaikan flag tak
dikenal atau gagal. Layak dicek sebelum Step OpenCode diandalkan.

---

## 6. Lapisan model: alat mendukung gambar, tapi model tidak melihat

Perluasan lingkup (diminta setelah pass pertama). Kasusnya: CLI-nya mendukung
gambar, tapi model yang sedang dipakai tidak punya kemampuan vision.

**Ringkasan yang paling penting, dan ia berbeda dari dugaan awal:** kegagalan
ini **tidak senyap terhadap model** — ketiga alat yang bisa saya telusuri
kodenya menyisipkan catatan teks in-band sebagai ganti gambar. Tapi ia
**senyap terhadap orkestrator**: exit code tetap 0, tidak ada event
terstruktur, dan parser sandcastle membuang catatan itu. Jadi kegagalannya
*ada di transcript* tapi *tidak ada di sinyal apa pun yang dibaca mesin*.

### 6.1 Bagaimana model dipilih, dan apakah terlihat dari luar

Jawaban paling penting bukan "flag apa" melainkan **arah informasinya**:
orkestrator tidak perlu *menemukan* model — ia yang **memasoknya**.

Sandcastle 0.12.0 **selalu** mengirim flag model secara eksplisit untuk keenam
provider, dan nilainya datang dari kode pemanggil sendiri (`claudeCode("…")`,
`codex("…")`, dst.):

| Alat | Flag yang dikirim sandcastle | Mekanisme lain |
|---|---|---|
| Claude Code | `--model <m>` (`src/AgentProvider.ts:1213`) | env `ANTHROPIC_MODEL`, kunci `model` di settings.json, `/model` saat sesi |
| Codex | `-m <m>` (`src/AgentProvider.ts:811`) | `model = "…"` di `~/.codex/config.toml`; `-c model="…"`; `-p/--profile` |
| OpenCode | `--model <provider/model>` (`src/AgentProvider.ts:981`) | config OpenCode |
| pi | `--model <m>` (`src/AgentProvider.ts:651`) | `--provider`, `~/.pi/agent/models.json` |

Jadi model bukan hidden state — ia argumen. **Verified.**

**Presedensi flag vs env — diuji untuk Claude Code.** `.sandcastle/.env`
mendarat di env proses sandbox lewat `mergeProviderEnv`
(`src/mergeProviderEnv.ts:26-30`), jadi `ANTHROPIC_MODEL` di sana bisa
bertabrakan dengan `--model` yang selalu dikirim. Uji: satu panggilan print
dengan `ANTHROPIC_MODEL=claude-sonnet-4-5-20250929` **dan**
`--model claude-haiku-4-5-20251001`. Semua event `assistant` di stream
melaporkan `"model":"claude-haiku-4-5-20251001"` — **flag menang**.
**Verified** untuk Claude Code 2.1.232. Untuk Codex/OpenCode/pi presedensi
serupa adalah **inference** (konvensi CLI umum; belum saya uji).

**Konfirmasi runtime.** Claude Code menggemakan model yang dipakai di setiap
event `assistant` stream-json (`"model":"claude-haiku-4-5-20251001"` di output
uji §3.1). Tapi `parseStreamJsonLine` sandcastle hanya mengekstrak
`text` / `tool_call` / `result` / `session_id` (`src/AgentProvider.ts:67-121`)
— field `model` **dibuang**. Orkestrator yang mau ground truth (bukan sekadar
percaya pada apa yang ia kirim) harus mem-parse stream sendiri. **Verified.**

### 6.2 Apa yang terjadi kalau gambar dikirim ke model non-vision

Ditelusuri ke source untuk tiga dari empat alat. **Tidak ada yang membuang
diam-diam terhadap model**; semua menyisipkan penanda teks in-band.

**Codex 0.147.0 — dua jalur, keduanya berisik.**

Jalur tool `view_image` menolak duluan dan mengembalikan error **ke model**
(`codex-rs/core/src/tools/handlers/view_image.rs:89-98`, tag `rust-v0.147.0`):

```rust
if !invocation.turn.model_info.input_modalities.contains(&InputModality::Image) {
    return Err(FunctionCallError::RespondToModel(
        VIEW_IMAGE_UNSUPPORTED_MESSAGE.to_string(),
    ));
}
```

dengan `VIEW_IMAGE_UNSUPPORTED_MESSAGE = "view_image is not allowed because you
do not support image inputs"` (`:49-50`).

Jalur `-i/--image` (dan gambar apa pun yang sudah ada di konteks) dibersihkan
oleh `strip_images_when_unsupported`
(`codex-rs/core/src/context_manager/normalize.rs:318-343`):

> *"Strip image content from messages and tool outputs when the model does not
> support images."*

```rust
let supports_images = input_modalities.contains(&InputModality::Image);
if supports_images { return; }
… ContentItem::InputImage { .. } => {
      normalized_content.push(ContentItem::InputText {
          text: IMAGE_CONTENT_OMITTED_PLACEHOLDER.to_string(),
      });
  }
```

Teks placeholder-nya, dari biner 0.147.0:
`<image content omitted because you do not support image input>`. Ada varian
lain untuk sebab lain: `…because remote image URLs are not supported`,
`…because it exceeded the supported size limit; use a smaller image`,
`…because it could not be processed`. **Verified.**

**OpenCode 1.18.15 — memvalidasi sebelum kirim, dan menyuruh model melapor.**
Lihat §6.3.

**pi 0.73.1 — catatan ditempel di depan hasil tool.** `getNonVisionImageNote`
(`dist/core/tools/read.js:47-51`) menghasilkan
`[Current model does not support images. The image will be omitted from this
request.]`, dan catatan itu digabung ke `textNote` yang dikirim bersama blok
gambar (`dist/core/tools/read.js:169-198`). Menariknya pi **tetap** menyertakan
blok `{ type: "image", … }` di `content` — pembuangan sebenarnya terjadi di
lapisan klien LLM di bawahnya; yang dijamin sampai ke model adalah catatan
teksnya. **Verified** dari source; **tidak** diuji end-to-end (pi tidak
terpasang di mesin ini).

**Claude Code 2.1.232 — tidak bisa dipastikan.** Saya tidak menemukan gerbang
kapabilitas di CLI-nya, dan tidak mencoba membongkar bundle yang di-minify.
Risikonya secara struktural mendekati nol: Claude Code hanya bicara ke model
Claude (langsung atau lewat Bedrock/Vertex/Foundry), dan seluruh model Claude
yang beredar menerima gambar — **inference**, bukan hasil verifikasi.

**Yang senyap adalah lapisan orkestrator, bukan lapisan model.** Tiga hal
menumpuk:

1. Proses agent tetap **exit 0**. Tidak ada gambar ≠ tidak ada kerja.
2. Tidak ada event terstruktur untuk "lampiran dibuang" di skema stream
   manapun yang saya periksa — penandanya adalah **teks biasa** di dalam hasil
   tool atau isi pesan.
3. `parseStreamLine` sandcastle hanya mengekstrak `text` / `tool_call` /
   `result` / `session_id` untuk setiap provider (`src/AgentProvider.ts:67-121`,
   `:546-611`, `:699-747`, `:888-943`). Penanda itu hanya lolos kalau kebetulan
   ikut di dalam teks jawaban akhir.

Akibatnya deteksi bergantung penuh pada **model memilih untuk merelai catatan
itu**. Hanya OpenCode yang memerintahkannya secara eksplisit (`Inform the
user.`) — dan dalam uji §3.3 modelnya memang patuh. Untuk Codex dan pi,
perilaku itu tidak diperintahkan; ia terserah model.

### 6.3 OpenCode: apakah ia memvalidasi sebelum mengirim? Ya.

Ini kasus yang paling penting karena OpenCode menerima banyak provider,
termasuk model teks-saja lewat OpenRouter dan model lokal.

Tool `read` sendiri **tidak** memeriksa apa pun — ia selalu melampirkan berkas
sebagai base64 (`toModelOutput`, dari biner 1.18.15):

```js
toModelOutput:({input:R,output:W})=>{
  if(!("encoding"in W)||W.encoding!=="base64"||!i8.has(W.mime))return[];
  return[{type:"text",text:"Image read successfully"},
         {type:"file",data:W.content,mime:W.mime,name:R.path}]
}
```

dengan `i8 = new Set(["image/jpeg","image/png","image/gif","image/webp"])`.

Validasinya ada satu lapisan lebih bawah, di normalisasi pesan sebelum
dikirim ke provider:

```js
let X = J.type==="image" ? String(J.image).split(";")[0].replace("data:","") : J.mediaType,
    G = J.type==="file" ? J.filename : void 0,
    W = pk(X);                       // mime → modalitas
if(!W) return J;
if(Z.capabilities.input[W]) return J;   // model mendukung modalitas ini → lolos
return { type:"text",
         text:`ERROR: Cannot read ${G?`"${G}"`:W} (this model does not support ${W} input). Inform the user.` }
```

**Verified.** Jadi: OpenCode **memvalidasi terhadap `model.capabilities.input`
per modalitas**, dan mengganti lampiran dengan pesan error yang secara
eksplisit menyuruh model memberi tahu user. Bukan diteruskan begitu saja, dan
bukan dibuang diam-diam. Berlaku untuk semua modalitas (image, audio, video,
pdf), bukan cuma gambar.

Metode: string diekstrak dari biner terkompilasi
`/opt/homebrew/Cellar/opencode/1.18.15/libexec/lib/node_modules/opencode-ai/bin/opencode.exe`
(bundle Bun). Saya tidak berhasil memetakannya ke path source di `sst/opencode`
lewat pencarian kode GitHub, jadi sitasinya adalah biner + versi, bukan
file:baris. Kode di atas dikutip apa adanya (identifier ter-minify).

### 6.4 Daftar kapabilitas model yang bisa dibaca mesin

| Alat | Tersedia? | Bentuk |
|---|---|---|
| **OpenCode** 1.18.15 | **Ya, terbaik** | `opencode models --verbose` → JSON per model dengan `capabilities.attachment` dan `capabilities.input.{text,audio,image,video,pdf}` |
| **pi** 0.73.1 | **Ya** | `pi --list-models [search]` → tabel dengan kolom `images` (`yes`/`no`) |
| **Codex** 0.147.0 | **Tidak dari CLI** | `model_info.input_modalities` internal; `codex doctor --json` diperiksa — tidak memuat modalitas |
| **Claude Code** 2.1.232 | **Tidak ditemukan** | tidak ada subcommand `models` di `--help` |

**OpenCode.** Output `opencode models --verbose` untuk `opencode/big-pickle`:

```json
"capabilities": {
  "temperature": true, "reasoning": true,
  "attachment": false, "toolcall": true,
  "input":  { "text": true, "audio": false, "image": false, "video": false, "pdf": false },
  "output": { "text": true, "audio": false, "image": false, "video": false, "pdf": false }
}
```

**Verified** — dan ini sekaligus **menjelaskan mundur kegagalan uji §3.3**:
`image: false` pada `big-pickle` persis sebabnya. Datanya di-cache dari
**models.dev** (`opencode models --refresh` untuk menyegarkan).

**pi.** `listModels` membangun kolom `images` dari registry
(`dist/cli/list-models.js`):

```js
images: m.input.includes("image") ? "yes" : "no",
```

Skema registry-nya mendeklarasikan `input` sebagai array
`Type.Union([Type.Literal("text"), Type.Literal("image")])`
(`dist/core/model-registry.js:108`, `:125`). **Verified.** Bentuknya tabel
teks, bukan JSON — bisa di-parse, tapi kurang stabil dibanding output OpenCode.

**Codex.** `codex --help` 0.147.0 tidak punya subcommand `models`.
`codex doctor --json` (*"Emit a redacted machine-readable report"*) saya
jalankan: kuncinya `schemaVersion`, `generatedAt`, `overallStatus`,
`codexVersion`, `checks` — **tidak ada** modalitas model. **Verified negatif.**
Kapabilitasnya hidup sebagai `model_info.input_modalities` di dalam proses.
Lead yang belum saya telusuri: `codex-rs/app-server/src/models.rs` menyebut
`input_modalities`, jadi kemungkinan `codex app-server` (eksperimental)
mengeksposnya lewat protokol — **belum diperiksa**.

**Claude Code.** Tidak ditemukan daftar kapabilitas yang bisa dibaca mesin.
Dalam praktik tidak dibutuhkan selama modelnya Claude (lihat §6.2).

### 6.5 Konsekuensi tambahan untuk desain

1. **Control plane harus punya satu sumber kapabilitas vision sendiri**, dan
   memutuskan **sebelum** giliran dimulai. Menanyakannya ke alat tidak seragam:
   dua alat menjawab, dua tidak. **Saran** (bukan temuan): **models.dev** —
   sumber yang sudah dipakai OpenCode — bisa jadi satu registry untuk keempat
   alat.
2. **Kalau Step memakai model non-vision, jangan kirim gambarnya sama sekali.**
   Kirim derivasi teksnya dan catat di Turn bahwa lampiran dilewati. Ini
   mengubah kegagalan tak terlihat menjadi keputusan tercatat.
3. **Kalau tetap dikirim, jangan andalkan agent melapor.** Kalau kita mau
   deteksi runtime, orkestrator harus mem-parse stdout agent sendiri dan
   mencocokkan penanda literal per alat — sandcastle membuangnya. Daftar
   penandanya:
   - Codex: `view_image is not allowed because you do not support image inputs`,
     `<image content omitted because you do not support image input>`
   - OpenCode: `ERROR: Cannot read … (this model does not support image input). Inform the user.`
   - pi: `[Current model does not support images. The image will be omitted from this request.]`

   Ini rapuh — string bebas yang bisa berubah kapan saja tanpa versi mayor.
   Pakai sebagai jaring pengaman, bukan sebagai mekanisme utama.
4. **Presedensi model sudah aman untuk Claude Code**: `--model` mengalahkan
   `ANTHROPIC_MODEL`, jadi `.sandcastle/.env` tidak bisa diam-diam menukar
   model di bawah kaki orkestrator (**verified**; untuk tiga alat lain masih
   **inference**).
