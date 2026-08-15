# Skill di dalam Sandbox non-interaktif, dan `gh` dengan installation token

Riset untuk issue [#138](https://github.com/adryanev/factory/issues/138) (bagian
dari #131). Empat pertanyaan: (1) dari mana tiap alat memuat skill dan apakah
lokasinya bisa dipindah, (2) apakah `/nama-skill` benar-benar memuat instruksi di
mode non-interaktif, (3) operasi wayfinder mana yang bisa dijalankan `gh` dengan
GitHub App installation token, (4) apakah ada mekanisme skill yang membaca berkas
di luar working directory.

---

## Jawaban singkat

**Skill bekerja non-interaktif — tapi bentuk perintah yang dibangun sandcastle
0.12.0 merusaknya untuk sebagian skill, termasuk `/wayfinder`.**

Claude Code mengembangkan (expand) `/nama-skill` di sisi klien sebelum prompt
dikirim ke model. Sandcastle memanggil `claude ... -p -` dengan prompt lewat
stdin (`dist/index.js:3431`), dan bentuk `-p -` itu membuat literal `-` ikut
menjadi teks prompt: pesan user yang tersimpan di transcript adalah
`"-\n/nonce-plain"`, bukan `"/nonce-plain"`. Karena garis miring tidak lagi di
awal prompt, **client-side expansion tidak jalan**. Yang tersisa hanyalah jalur
kedua: model memanggil `Skill` tool sendiri. Jalur kedua itu tertutup untuk skill
ber-`disable-model-invocation: true` — dan `wayfinder` adalah satu-satunya skill
di set ini yang memakainya
([`~/.claude-lexicon/skills/wayfinder/SKILL.md:4`](file:///Users/adryanev/.claude-lexicon/skills/wayfinder/SKILL.md)).

Hasilnya, dengan bentuk perintah sandcastle apa adanya: `/grilling`,
`/prototype`, `/research` **jalan**; `/wayfinder` **tidak**. Ganti `-p -` menjadi
`-p` telanjang (atau hilangkan `-p` sama sekali) dan `/wayfinder` langsung jalan.
Rinciannya di [§3](#3-apakah-skill-bisa-dipanggil-non-interaktif).

**Premis netralitas alat tidak berlubang di sisi mekanisme, tapi berlubang di
sisi semantik.** Keempat alat (Claude Code, Codex, OpenCode, pi) punya mekanisme
skill berbasis `SKILL.md`, dan tiga di antaranya membaca `~/.agents/skills/`
sebagai lokasi bersama. Tapi tiap alat memberi arti berbeda pada frontmatter yang
sama: OpenCode **mengabaikan** `disable-model-invocation` (jadi `/wayfinder` jalan
di sana justru karena alat itu kurang patuh), Codex hanya menaruh katalog
nama+deskripsi dan tidak mengenal flag itu sama sekali. Rincian di
[§2](#2-di-mana-tiap-alat-memuat-skill).

**Tidak ada satu pun endpoint yang dibutuhkan mekanika wayfinder yang tertutup
untuk GitHub App installation token** — termasuk sub-issues dan issue
dependencies. Yang tertutup adalah `GET /user`, dan itu cukup untuk mematahkan
satu langkah: `gh issue edit <n> --add-assignee @me`. Rinciannya di
[§5](#5-gh-dengan-github-app-installation-token).

---

## 0. Cakupan, versi, dan sumber

Yang relevan hanya **mode non-interaktif**, persis dalam bentuk perintah yang
dibangun sandcastle 0.12.0 — sama seperti cakupan di
[`jendela-konteks-per-alat.md`](./jendela-konteks-per-alat.md).

Versi yang diuji, semuanya di mesin macOS 25.6.0 ini:

| Komponen | Versi | Lokasi |
| --- | --- | --- |
| Claude Code | `2.1.232` | `/opt/homebrew/Caskroom/claude-code@latest/2.1.232/claude` |
| Codex CLI | `0.147.0` | `/opt/homebrew/Caskroom/codex/0.147.0/bin/codex` |
| OpenCode | `1.18.15` | `/opt/homebrew/bin/opencode` |
| GitHub CLI | `2.97.0` | `/opt/homebrew/bin/gh` |
| sandcastle | `0.12.0` | `node_modules/.pnpm/@ai-hero+sandcastle@0.12.0/` |
| pi | **tidak terpasang** | — |

Sumber GitHub API: **deskripsi OpenAPI resmi GitHub**,
`descriptions/api.github.com/api.github.com.json` dari
[`github/rest-api-description`](https://github.com/github/rest-api-description),
`info.version` = `1.1.4`, diunduh 15 Agustus 2026. Ini sumber yang memiliki
field `x-github.enabledForGitHubApps` — halaman docs HTML tidak memuatnya dalam
bentuk yang bisa dibaca mesin.

### Yang diuji dengan menjalankan sesuatu, versus yang dibaca

**Dijalankan sendiri** (§2 sebagian, §3 sebagian, §4):

- Claude Code: 8 invocation nyata dengan skill nonce buatan sendiri, model
  `claude-haiku-4-5-20251001`.
- Codex: `codex debug prompt-input` (merender daftar prompt input yang dilihat
  model, tanpa memanggil API) dengan `CODEX_HOME` di-override. Run end-to-end
  **gagal** karena akun ChatGPT di mesin ini menolak setiap model yang dicoba —
  jadi bagian "model benar-benar memanggil skill tool" untuk Codex **tidak
  terverifikasi**.
- OpenCode: `opencode debug skill` (enumerasi discovery) plus 2 run nyata dengan
  model `opencode/deepseek-v4-flash-free`.

**Dibaca saja, tidak dijalankan** (§5 seluruhnya, pi di §2):

- Seluruh bagian GitHub App: tidak ada GitHub App yang terpasang di repo ini dan
  tidak ada installation token yang bisa dicetak tanpa membuat App baru — itu
  tindakan yang keluar dari cakupan riset. Semua klaim di §5 bersandar pada
  deskripsi OpenAPI GitHub dan halaman permissions resmi.
- pi: tidak terpasang; klaimnya bersandar pada dokumentasi repo `pi-mono`.

Skill nonce yang dipakai di seluruh eksperimen — tiap skill hanya berisi satu
kalimat "balas token ini dan tidak lebih":

| Skill | Frontmatter khusus | Token |
| --- | --- | --- |
| `nonce-plain` | — | `QRZ7-PLAIN-88134` |
| `nonce-locked` | `disable-model-invocation: true` | `QRZ7-LOCKED-55902` |
| `nonce-cmd` (di `.claude/commands/`) | — | `QRZ7-CMD-31775` |
| `nonce-personal` | — | `QRZ7-PERSONAL-70466` |
| `nonce-outside` | — | `QRZ7-OUTSIDE-66666` |

Token yang tidak bisa ditebak dipakai supaya "skill benar-benar termuat" bisa
dibedakan dari "model mengarang jawaban yang masuk akal".

---

## 1. Kesimpulan yang menentukan desain

Empat hal, urut dari yang paling mengubah bentuk:

1. **Bentuk `-p -` yang dipakai sandcastle mematikan client-side slash
   expansion.** Ini bug pemanggilan, bukan batas alat. Perbaikannya satu karakter
   (`-p -` → `-p`), tapi letaknya di dalam sandcastle, bukan di factory.
   → [§3.2](#32-eksperimen-b-bentuk-perintah-menentukan-segalanya)
2. **`disable-model-invocation: true` adalah satu-satunya alasan `/wayfinder`
   berbeda dari `/grilling`.** Kalau bentuk perintah tidak bisa diubah, jalan
   lain adalah menyalin `wayfinder/SKILL.md` ke dalam Sandbox tanpa baris itu —
   tapi itu berarti skill **tidak** lagi "dipakai apa adanya".
   → [§3.1](#31-eksperimen-a-bentuk-sandcastle-apa-adanya)
3. **`~/.agents/skills/` adalah lokasi bersama tiga alat** (Codex, OpenCode, pi),
   tapi **bukan** untuk Claude Code. Claude Code hanya membaca
   `$CLAUDE_CONFIG_DIR/skills/`, `.claude/skills/`, dan direktori `--add-dir`.
   → [§2.5](#25-matriks-lokasi)
4. **Wayfinder step "Claim" (`--add-assignee @me`) tidak bisa dijalankan agent
   dengan installation token.** Bukan karena endpoint-nya tertutup, tapi karena
   `@me` tidak punya arti dan bot App tidak layak jadi assignee.
   → [§5.3](#53-dua-jebakan-yang-bukan-soal-izin)

---

## 2. Di mana tiap alat memuat skill

### 2.1 Claude Code 2.1.232

Lokasi resmi menurut dokumentasi
([code.claude.com/docs/en/skills](https://code.claude.com/docs/en/skills),
bagian "Where skills live"):

| Level | Path | Berlaku untuk |
| --- | --- | --- |
| Enterprise | lihat managed settings | semua user di organisasi |
| Personal | `~/.claude/skills/<nama>/SKILL.md` | semua project |
| Project | `.claude/skills/<nama>/SKILL.md` | project ini |
| Plugin | `<plugin>/skills/<nama>/SKILL.md` | tempat plugin aktif |

Tambahan yang penting untuk Sandbox:

- **`.claude/commands/*.md` sudah dilebur ke skill.** Dokumentasi menyebut
  eksplisit: "A file at `.claude/commands/deploy.md` and a skill at
  `.claude/skills/deploy/SKILL.md` both create `/deploy` and work the same way."
  Diverifikasi: `/nonce-cmd` dari `.claude/commands/nonce-cmd.md` muncul sebagai
  entri skill dan dipanggil lewat `Skill` tool ([§3.1](#31-eksperimen-a-bentuk-sandcastle-apa-adanya)).
- **Project skill juga dibaca dari setiap direktori induk** sampai root repo, dan
  dari `.claude/skills/` di dalam tiap direktori `--add-dir`.
- **Nested `.claude/skills/` di bawah cwd dimuat malas** — baru tersedia setelah
  Claude membaca/menulis berkas di subdirektori itu. Untuk factory ini berarti
  skill di subdirektori **tidak bisa diandalkan** ada di giliran pertama.
- **`--bare` mematikan semuanya.** Dokumentasi headless: "`--bare` … skipping
  auto-discovery of hooks, skills, plugins, MCP servers, auto memory, and
  CLAUDE.md." Sandcastle tidak memakai `--bare` (`dist/index.js:3431`), jadi ini
  bukan masalah sekarang — tapi dokumentasi juga bilang `--bare` "will become the
  default for `-p` in a future release". **Itu risiko yang harus dicatat**: kalau
  itu terjadi, seluruh premis "skill dipakai apa adanya" mati kecuali sandcastle
  ikut berubah.

**Override lokasi: `CLAUDE_CONFIG_DIR`.** Terverifikasi dengan menjalankan.
Mesin ini sendiri sudah memakainya (`CLAUDE_CONFIG_DIR=/Users/adryanev/.claude-lexicon`).
Dengan config dir kosong buatan sendiri:

```
$ cd $SP/proj && CLAUDE_CONFIG_DIR=$SP/cfg claude --print --verbose \
    --dangerously-skip-permissions --output-format stream-json \
    --model claude-haiku-4-5-20251001 -p -   <<< '/nonce-personal'
```

Event `system/init` melaporkan `slash_commands` turun dari **119 → 46**, dan
`nonce-personal` (yang hanya ada di `$SP/cfg/skills/`) muncul. Override bekerja.

**Konsekuensi yang menggigit:** run yang sama gagal dengan
`Not logged in · Please run /login`. Kredensial ikut config dir. Jadi di Sandbox,
memindahkan `CLAUDE_CONFIG_DIR` berarti **harus** menyediakan auth terpisah
(`ANTHROPIC_API_KEY`, atau menyalin kredensial ke config dir yang baru).

Flag lain yang relevan (dari `claude --help` 2.1.232): `--add-dir`,
`--plugin-dir`, `--settings`, `--append-system-prompt-file`.

### 2.2 Codex CLI 0.147.0

Codex **punya** mekanisme skill penuh — bukan hanya prompt template. Binary
memuat modul `codex_skills_extension` dengan `SkillTool` (`list` dan `read`),
telemetri `codex.thread.skills.enabled_total`, dan "skills context budget" yang
memangkas deskripsi kalau terlalu panjang. Feature flag `skill_search` berstatus
`stable`/`true` di `codex features list`.

Lokasi discovery, **dienumerasi dengan menjalankan** `codex debug prompt-input`
(perintah yang merender daftar prompt input yang dilihat model, tanpa memanggil
API), lalu memungut setiap locator `(file: …)` dari blok `<skills_instructions>`:

| Root | Jumlah skill terdeteksi | Cara verifikasi |
| --- | --- | --- |
| `$CODEX_HOME/skills/` | 1 (`nonce-codex`) | dibuat khusus untuk uji |
| `$CODEX_HOME/skills/.system/` | 5 | bawaan Codex (`imagegen`, `openai-docs`, `plugin-creator`, `skill-creator`, …) |
| `~/.agents/skills/` | 24 | sudah ada di mesin ini |
| `<cwd>/.agents/skills/` | 1 (`nonce-agents`) | dibuat khusus untuk uji |
| `<cwd>/.codex/skills/` | 1 (`nonce-projcodex`) | dibuat khusus untuk uji |

`~/.agents/skills` **tidak** dikonfigurasi di `~/.codex/config.toml` (dicek: tidak
ada kunci `skill` atau `agents` di sana), jadi itu root bawaan yang di-hardcode.

**Override lokasi: `CODEX_HOME`.** Terverifikasi — dengan
`CODEX_HOME=$SP/codexhome`, katalog skill berpindah ke path scratch itu. String
di binary mengonfirmasi: `return os.path.join(_codex_home(), "skills")` dan
`os.environ.get("CODEX_HOME", os.path.expanduser("~/.codex"))`.

**Bentuk pemuatan berbeda dari Claude Code.** Yang masuk ke prompt hanyalah
katalog — nama, deskripsi, dan locator berkas:

```
<skills_instructions>
## Skills
A skill is a set of instructions provided through a `SKILL.md` source. Below is
the list of skills that can be used. Each entry includes a name, description, and
source locator. …
### Available skills
- imagegen: … (file: …/skills/.system/imagegen/SKILL.md)
```

Isi `SKILL.md` **tidak** ikut. Diverifikasi: tidak satu pun token `QRZ7-*` muncul
di payload prompt input, padahal `nonce-codex` ada di katalog. Codex membaca
badan skill belakangan lewat tool.

**Codex tidak mengenal `disable-model-invocation`.** Binary memuat validator
frontmatter yang menolak kunci tak dikenal
(`"Unexpected key(s) in SKILL.md frontmatter: {unexpected}. Allowed properties
are: {allowed}"`) — tapi itu milik `init_skill.py`, skrip scaffolding, bukan
loader. Skill `nonce-locked` tetap muncul di katalog Codex.

**Custom prompt (`$CODEX_HOME/prompts/*.md`) bukan skill dan tidak muncul di
katalog.** Diverifikasi: `nonce-prompt.md` ada di `$SP/codexhome/prompts/`, dan
`nonce-prompt` **nol kali** muncul di seluruh payload prompt input.

### 2.3 OpenCode 1.18.15

OpenCode punya subcommand `opencode debug skill` yang mendaftar setiap skill yang
terdeteksi beserta path sumbernya — enumerasi discovery yang langsung bisa
dibaca. Dijalankan dari `$SP/proj`, hasilnya **54 skill** dari root berikut:

| Root | Contoh |
| --- | --- |
| built-in | `customize-opencode` (`"location": "<built-in>"`) |
| `~/.config/opencode/skills/` | 47 skill, termasuk `wayfinder` |
| `~/.agents/skills/` | `teach`, `grill-design` |
| `<cwd>/.claude/skills/` | `nonce-plain`, `nonce-locked` |
| `<cwd>/.agents/skills/` | `nonce-agents` |
| `<cwd>/.opencode/skills/` | `nonce-oc-plur` |
| `<cwd>/.opencode/skill/` | `nonce-oc-sing` |

Dua hal yang menonjol:

- **OpenCode membaca `.claude/skills/` milik project.** Skill Claude Code yang
  ikut ter-checkout bersama repo langsung tersedia di OpenCode tanpa penyesuaian
  apa pun. Ini bagian premis netralitas alat yang paling kuat.
- **`.opencode/skill/` (tunggal) dan `.opencode/skills/` (jamak) dua-duanya
  dibaca.**
- Yang **tidak** dibaca: `~/.claude/skills/` level user, dan `.claude/commands/`.
  `nonce-cmd` tidak muncul di daftar 54 itu.

Konfigurasi mengikuti path XDG (`opencode debug paths` melaporkan
`config /Users/adryanev/.config/opencode`), jadi lokasinya dapat dipindah lewat
`XDG_CONFIG_HOME` — **ini belum saya uji**, hanya inferensi dari output
`debug paths`.

### 2.4 pi

**Tidak terpasang di mesin ini.** Semua di bawah ini dibaca, tidak dijalankan;
sumbernya dokumentasi repo `pi-mono`
([`packages/coding-agent/docs/skills.md`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/skills.md),
[`usage.md`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/usage.md)).

pi **punya** mekanisme skill berbasis `SKILL.md` dengan progressive disclosure
yang sama polanya: hanya deskripsi yang selalu di konteks, badan dimuat saat
dipakai.

| Level | Path |
| --- | --- |
| Global | `~/.pi/agent/skills/`, `~/.agents/skills/` |
| Project | `.pi/skills/`, `.agents/skills/` (cwd dan direktori induk) |

Invocation: `/skill:nama`, dengan argumen ditempel sebagai `User: <args>`.

**Override lokasi paling eksplisit dari keempat alat:** flag `--skill <path>`
(repeatable, aditif, dan tetap berlaku bersama `--no-skills`), plus array
`skills` di `settings.json`. Tidak ada env var khusus yang disebutkan
dokumentasi.

Mode non-interaktif: `-p`/`--print`, `--mode json`, `--mode rpc`. **Dokumentasi
tidak menyatakan apakah `/skill:nama` dikembangkan di mode non-interaktif** —
tidak terjawab, dan tidak bisa saya uji tanpa memasang pi.

### 2.5 Matriks lokasi

| Lokasi | Claude Code | Codex | OpenCode | pi |
| --- | :---: | :---: | :---: | :---: |
| `~/.agents/skills/` | ✗ | ✓ | ✓ | ✓ |
| `<cwd>/.agents/skills/` | ✗ | ✓ | ✓ | ✓ |
| `<cwd>/.claude/skills/` | ✓ | ✗ | ✓ | ✗ |
| Config dir user | `$CLAUDE_CONFIG_DIR/skills/` | `$CODEX_HOME/skills/` | `~/.config/opencode/skills/` | `~/.pi/agent/skills/` |
| Project dir khas alat | `.claude/skills/` | `.codex/skills/` | `.opencode/skill{,s}/` | `.pi/skills/` |
| Override lewat env | `CLAUDE_CONFIG_DIR` ✓ | `CODEX_HOME` ✓ | `XDG_CONFIG_HOME` (belum diuji) | tidak ada |
| Override lewat flag | `--add-dir`, `--plugin-dir` | tidak ada | tidak ada | `--skill <path>` |
| `disable-model-invocation` dipatuhi | ✓ | ✗ | ✗ | tidak diketahui |
| Custom command terpisah dari skill | ✗ (sudah dilebur) | ✓ (`prompts/`) | ✓ (`.opencode/command/`) | ✓ (prompt template) |

Baris `~/.agents/skills/` adalah jawaban paling berguna untuk Sandbox: **satu
direktori memberi makan Codex, OpenCode, dan pi sekaligus**. Claude Code butuh
salinan (atau symlink — lihat [§4](#4-membaca-berkas-di-luar-working-directory))
di `$CLAUDE_CONFIG_DIR/skills/`.

---

## 3. Apakah skill bisa dipanggil non-interaktif

### 3.1 Eksperimen A: bentuk sandcastle apa adanya

Perintah yang dijalankan — persis bentuk yang dibangun sandcastle 0.12.0 di
`node_modules/.pnpm/@ai-hero+sandcastle@0.12.0/node_modules/@ai-hero/sandcastle/dist/index.js:3431`,
hanya modelnya diganti yang murah:

```
$ cd $SP/proj
$ printf '/nonce-plain' | claude --print --verbose \
    --dangerously-skip-permissions --output-format stream-json \
    --model claude-haiku-4-5-20251001 -p -
```

Empat prompt, empat hasil:

| Prompt | Sumber skill | Hasil | Bukti |
| --- | --- | --- | --- |
| `/nonce-plain` | `.claude/skills/` | ✅ | `tool_use: Skill {"skill":"nonce-plain"}` → `QRZ7-PLAIN-88134` |
| `/nonce-cmd` | `.claude/commands/` | ✅ | `tool_use: Skill {"skill":"nonce-cmd"}` → `QRZ7-CMD-31775` |
| `/nonce-locked` | `.claude/skills/`, `disable-model-invocation: true` | ❌ | tidak ada tool call; model menjawab *"I don't see `nonce-locked` in the available skills for this session"* |
| `Run the nonce-locked skill now and follow its instructions.` | idem | ❌ | model memanggil `nonce-cmd` (skill lain yang namanya paling mirip) dan mengeluarkan `QRZ7-CMD-31775` |

Prompt keempat menutup celah interpretasi: bukan sintaks garis miringnya yang
gagal, melainkan skill itu memang **tidak ada** di daftar yang dilihat model.

Yang menarik: `nonce-locked` **tetap muncul** di `slash_commands` pada event
`system/init` — CLI tahu skill itu ada. Yang tidak tahu adalah model. Dua jalur,
dan hanya satu yang hidup di bentuk ini.

Bukti mekanismenya ada di transcript sesi. Pesan user pertama yang tersimpan di
`~/.claude-lexicon/projects/…-scratchpad-proj/0289bc89-….jsonl`:

```json
"-\n/nonce-plain"
```

Prompt tidak dikembangkan. Literal `-` dari `-p -` ikut menjadi teks, garis
miring bukan lagi karakter pertama, dan model yang harus memutuskan sendiri untuk
memanggil `Skill` tool.

Ini **bertentangan dengan dokumentasi**. Halaman headless resmi
([code.claude.com/docs/en/headless](https://code.claude.com/docs/en/headless))
menulis:

> User-invoked skills and custom commands work in `-p` mode: include
> `/skill-name` in the prompt string and Claude Code expands it before running.

Kalimat itu benar — tapi hanya untuk bentuk pemanggilan yang tidak dipakai
sandcastle.

### 3.2 Eksperimen B: bentuk perintah menentukan segalanya

Prompt yang sama (`/nonce-locked`), empat bentuk pemanggilan, flag lain identik:

| # | Bentuk | Prompt sampai ke Claude Code lewat | Hasil |
| --- | --- | --- | --- |
| B1 | `-p -` **(bentuk sandcastle)** | stdin, plus argv `-` | ❌ `QRZ7-LOCKED-55902` tidak keluar |
| B2 | `-p '/nonce-locked'` | argv | ✅ keluar |
| B3 | `-p` telanjang, prompt di-pipe | stdin | ✅ keluar |
| B4 | tanpa `-p` sama sekali, prompt di-pipe | stdin | ✅ keluar |

B3 dan B4 mematikan hipotesis "stdin tidak bisa di-expand". Yang merusak adalah
argumen `-` itu sendiri, yang oleh Claude Code 2.1.232 diperlakukan sebagai teks
prompt dan bukan sebagai penanda "baca stdin".

**Konsekuensinya buat factory:** perbaikannya ada di sandcastle, satu karakter:

```js
// dist/index.js:3431 — sekarang
command: `claude --print --verbose${permissionFlag} --output-format stream-json --model ${shellEscape(model)}${effortFlag}${resumeFlag}${forkFlag} -p -`,
stdin: prompt
```

Menghapus ` -` di ujung memulihkan expansion. Karena factory hanya memegang seam
`startTurn(spec)` dan `startTurn` memanggil sandcastle, factory **tidak bisa**
memperbaiki ini dari sisinya sendiri tanpa patch/fork sandcastle atau upstream
fix.

Kalau bentuk perintah tidak bisa disentuh, tiga jalan keluar, dari yang paling
jujur ke premis:

1. **Buang `disable-model-invocation: true` dari salinan `wayfinder/SKILL.md`
   yang dipasang di Sandbox.** Satu baris. Tapi skill tidak lagi "apa adanya",
   dan model jadi bisa memanggil `/wayfinder` sendiri tanpa diminta — persis
   perilaku yang flag itu ada untuk mencegah.
2. **Tempel isi `SKILL.md` ke dalam prompt** (control plane membaca berkasnya dan
   mengirimnya sebagai teks). Selalu bekerja, di semua alat, tapi kehilangan
   progressive disclosure: badan skill membebani konteks tiap giliran.
3. **`--append-system-prompt-file`** menunjuk ke `SKILL.md`. Sama-sama tidak lewat
   jalur skill, dan sandcastle juga tidak membangun flag itu.

### 3.3 Codex

`/nonce-codex` **tidak** dikembangkan. Payload dari `codex debug prompt-input`
menyimpan item terakhir persis sebagai:

```
'/nonce-codex'
```

Sama seperti Claude Code dalam bentuk `-p -`: teks garis miring sampai ke model
apa adanya, dan model harus memutuskan memanggil skill tool. Bedanya, di Codex
skill itu **ada** di katalog (`- nonce-codex: Emit the codex skill nonce. …
(file: …)`), jadi jalur itu terbuka.

`/nonce-prompt` (custom prompt di `$CODEX_HOME/prompts/`) juga tidak
dikembangkan, **dan** tidak ada di katalog skill. Jadi custom prompt Codex
**tidak bisa dipakai** non-interaktif — tidak ada jalur kedua untuknya.

**Belum terverifikasi:** apakah model Codex benar-benar memanggil skill tool dan
mengeluarkan `QRZ7-CODEX-90218`. Run end-to-end gagal sebelum sampai model:

```
{"type":"error","message":"{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.\"}}"}
```

Empat model dicoba (`gpt-5.6-sol`, `gpt-5.2-codex`, `gpt-5.1-codex`,
`gpt-5.1-codex-mini`), semuanya ditolak dengan pesan yang sama. Ini batas akun di
mesin ini, bukan sifat Codex.

### 3.4 OpenCode

Dua run nyata, model `opencode/deepseek-v4-flash-free`, dari `$SP/proj`:

```
$ opencode run --format json -m opencode/deepseek-v4-flash-free "/nonce-plain"
```

| Prompt | Hasil | Bukti |
| --- | --- | --- |
| `/nonce-plain` | ✅ | `tool: skill {"name":"nonce-plain"}` → teks `QRZ7-PLAIN-88134` |
| `/nonce-locked` | ✅ | `tool: skill {"name":"nonce-locked"}` → teks `QRZ7-LOCKED-55902` |

Dua fakta penting sekaligus:

- Skill di **`.claude/skills/`** milik project dimuat OpenCode tanpa penyesuaian.
- OpenCode **mengabaikan `disable-model-invocation`**. `/wayfinder` akan jalan di
  OpenCode non-interaktif justru karena alat itu tidak memberlakukan flag yang
  Claude Code berlakukan.

Ini inversi yang harus terdengar: **skill yang sama, frontmatter yang sama,
perilaku berbeda per alat.** "Skill dipakai apa adanya" benar di tingkat berkas,
tapi tidak menjamin perilaku yang sama.

### 3.5 Ringkasan §3

| Alat | `/skill` non-interaktif | Cara | Menghormati `disable-model-invocation` |
| --- | --- | --- | --- |
| Claude Code, bentuk `-p -` | sebagian | model memanggil `Skill` tool | ✓ → `/wayfinder` **gagal** |
| Claude Code, bentuk lain | penuh | expansion di sisi klien | ✓ tapi tidak relevan (expansion menang) |
| Codex | katalog terbuka, run belum diuji | model memanggil skill tool | ✗ (tidak dikenal) |
| OpenCode | penuh | model memanggil `skill` tool | ✗ |
| pi | tidak diketahui | — | tidak diketahui |

---

## 4. Membaca berkas di luar working directory

Ya, dan lewat empat jalur berbeda. Ini relevan langsung: kalau knowledge repo
di-mount di tempat lain di dalam Sandbox, jalur yang sama bisa dipakai untuk
skill.

**1. `--add-dir` (terverifikasi dengan menjalankan).** Skill diletakkan di
`$SP/outside/.claude/skills/nonce-outside/`, jauh di luar cwd:

```
$ cd $SP/proj
$ printf '/nonce-outside' | claude --print --verbose \
    --dangerously-skip-permissions --add-dir $SP/outside \
    --output-format stream-json --model claude-haiku-4-5-20251001 -p -
```

Hasil: `tool_use: Skill {"skill":"nonce-outside"}` → `QRZ7-OUTSIDE-66666`.
Berhasil, **dan berhasil justru dalam bentuk `-p -` yang gagal untuk
`nonce-locked`** — menegaskan lagi bahwa yang rusak di §3.1 adalah expansion,
bukan discovery.

Dokumentasi mengonfirmasi: "To load skills from a directory outside that path at
startup, pass it with `--add-dir`. Claude Code reads `.claude/skills/` inside each
added directory alongside the project skills."

**2. Symlink (dibaca, tidak diuji).** Dokumentasi skills:

> A `<skill-name>` entry in the enterprise, personal, or project locations can be
> a symlink to a directory elsewhere on disk. Claude Code follows the symlink and
> reads `SKILL.md` from the target directory, and if the same target is reachable
> from more than one location, Claude Code loads the skill once.

Mesin ini sudah memakai pola itu untuk hal lain — `~/.codex/AGENTS.md` dan
`~/.codex/config.toml` keduanya symlink ke `~/.dotfiles/`.

**3. Skill membaca berkas absolut di luar cwd, dari dalam badan skill sendiri.**
Ini yang paling relevan untuk wayfinder, dan buktinya ada di sesi riset ini:

- Skill `research` yang menjalankan riset ini dimuat dari
  `/Users/adryanev/.claude-lexicon/skills/research/` — di luar repo.
- `wayfinder/SKILL.md` menyuruh pembacanya *"Consult the tracker doc's
  'Wayfinding operations' section"* — dan dokumen itu ada di direktori **skill
  lain**:
  [`~/.claude-lexicon/skills/setup-matt-pocock-skills/issue-tracker-github.md`](file:///Users/adryanev/.claude-lexicon/skills/setup-matt-pocock-skills/issue-tracker-github.md).

Artinya: memasang `wayfinder` saja **tidak cukup**. Tanpa
`setup-matt-pocock-skills/issue-tracker-github.md` ikut hadir di Sandbox,
`/wayfinder` akan jatuh ke default local-markdown tracker dan tidak akan menyentuh
GitHub sama sekali. Ini dependensi antar-skill yang tidak terlihat dari nama
skill-nya.

**4. Root bersama lintas alat.** `~/.agents/skills/` (Codex, OpenCode, pi) berada
di luar working directory menurut definisi. Untuk Sandbox, ini satu mount point
yang melayani tiga alat.

---

## 5. `gh` dengan GitHub App installation token

**Seluruh bagian ini dibaca, bukan dijalankan** — lihat
[§0](#0-cakupan-versi-dan-sumber). Tidak ada installation token yang tersedia
tanpa membuat GitHub App baru.

Sandcastle **punya** blok instalasi `gh` — `GITHUB_CLI_TOOLS` di
`dist/main.js:18424`, isinya `apt-get install -y gh` dari repo `cli.github.com`.
Tapi blok itu hanya dipasang lewat template arg `ISSUE_TRACKER_TOOLS` ketika
issue tracker yang dipilih adalah `github-issues` (`dist/main.js:18452-18459`).
**Apakah `gh` ada di image default yang dipakai factory belum ditelusuri** — itu
tergantung bagaimana image dirakit, bukan pada blok ini.

Satu detail dari template yang sama yang layak dicatat: `envExample` untuk
`github-issues` meminta `GH_TOKEN` berupa **fine-grained personal access token**,
bukan installation token —

> `# Create a fine-grained token: https://github.com/settings/personal-access-tokens/new`
> `# Required repository permissions: Issues (Read and write) and Metadata (Read)`

Jadi jalur installation token adalah jalur yang sandcastle sendiri belum tempuh.

`gh` menerima token dari env: **`GH_TOKEN`**, lalu `GITHUB_TOKEN`
(`gh help environment` di v2.97.0: *"an authentication token that will be used
when a command targets either `github.com` … Setting this avoids being prompted to
authenticate and takes precedence over previously stored credentials"*).
Installation token (`ghs_…`) adalah bearer token biasa, jadi bentuknya cocok.

### 5.1 Operasi wayfinder → endpoint → izin → tersedia untuk App?

Operasi diambil dari bagian "Wayfinding operations" di
[`issue-tracker-github.md:36-45`](file:///Users/adryanev/.claude-lexicon/skills/setup-matt-pocock-skills/issue-tracker-github.md).
Kolom "App?" dari `x-github.enabledForGitHubApps` di deskripsi OpenAPI GitHub
v1.1.4; kolom "Izin" dari
[halaman permissions resmi](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps?apiVersion=2022-11-28)
(kolom `Tokens` di sana mencantumkan `UAT, IAT`; `IAT` = installation access
token).

| # | Operasi wayfinder | Perintah di skill | Endpoint REST | Izin | App? |
| --- | --- | --- | --- | --- | :---: |
| 1 | Buat map | `gh issue create --label wayfinder:map` | `POST /repos/{o}/{r}/issues` | `issues: write` | ✅ |
| 2 | Buat child ticket | `gh issue create` | `POST /repos/{o}/{r}/issues` | `issues: write` | ✅ |
| 3 | **Sub-issue** | `gh api … sub_issues` | `POST /repos/{o}/{r}/issues/{n}/sub_issues` | `issues: write` | ✅ |
| 4 | Daftar sub-issue | `gh api` | `GET /repos/{o}/{r}/issues/{n}/sub_issues` | `issues: read` | ✅ |
| 5 | **Dependency `blocked_by`** | `gh api --method POST … dependencies/blocked_by -F issue_id=…` | `POST /repos/{o}/{r}/issues/{n}/dependencies/blocked_by` | `issues: write` | ✅ |
| 6 | Baca blocker | `gh issue view` / `gh api` | `GET /repos/{o}/{r}/issues/{n}/dependencies/blocked_by` | `issues: read` | ✅ |
| 7 | Hapus dependency | `gh api --method DELETE` | `DELETE /repos/{o}/{r}/issues/{n}/dependencies/blocked_by/{issue_id}` | `issues: write` | ✅ |
| 8 | Label | `gh issue edit --add-label` | `POST` / `DELETE /repos/{o}/{r}/issues/{n}/labels` | `issues: write` | ✅ |
| 9 | Frontier query | `gh issue list --state open` | `GET /repos/{o}/{r}/issues` | `issues: read` | ✅ |
| 10 | Komentar | `gh issue comment` | `POST /repos/{o}/{r}/issues/{n}/comments` | `issues: write` | ✅ |
| 11 | Tutup | `gh issue close` | `PATCH /repos/{o}/{r}/issues/{n}` | `issues: write` | ✅ |
| 12 | Assign (endpoint) | `gh issue edit --add-assignee` | `POST /repos/{o}/{r}/issues/{n}/assignees` | `issues: write` | ✅ |
| 13 | **Claim (`@me`)** | `gh issue edit <n> --add-assignee @me` | GraphQL `viewer { login }`, lalu #12 | — | ❌ lihat §5.3 |
| — | (yang dibutuhkan `@me`) | — | `GET /user` | — | ❌ `enabledForGitHubApps: false` |

**Tidak ada satu pun endpoint issue yang dibutuhkan mekanika wayfinder yang
tertutup untuk installation token.** Sub-issues dan issue dependencies —
dua endpoint yang paling patut dicurigai karena paling baru — dua-duanya
`enabledForGitHubApps: true`. Satu izin, `issues: write` di level repository,
menutupi seluruh permukaan tulis.

Catatan tambahan dari OpenAPI: `POST …/dependencies/blocked_by` punya
`x-github.triggersNotification: true` dan deskripsinya memperingatkan
*"Creating content too quickly using this endpoint may result in secondary rate
limiting."* Sebuah map wayfinder yang membuat 20 tiket sekaligus lalu memasang
dependency antar-tiket akan menabrak batas itu kalau tidak diberi jeda.

### 5.2 Jebakan pertama: id database, bukan nomor issue

Dua endpoint memakai **database id**, dan bukan `#nomor` maupun `node_id`.
Diverifikasi dari skema request body di OpenAPI:

```json
// POST /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by
{"type":"object",
 "properties":{"issue_id":{"type":"integer",
   "description":"The id of the issue that blocks the current issue"}},
 "required":["issue_id"]}

// POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues
{"type":"object",
 "properties":{"sub_issue_id":{"type":"integer",
   "description":"The id of the sub-issue to add. The sub-issue must belong to
                  the same repository owner as the parent issue"},
               "replace_parent":{"type":"boolean"}},
 "required":["sub_issue_id"]}
```

Path `DELETE …/dependencies/blocked_by/{issue_id}` juga memakai id database di
path segment-nya. Jadi **tiga** tempat, bukan satu.

Ini bukan soal izin, tapi tetap layak masuk desain: setiap operasi bloking dan
sub-issue butuh satu round-trip tambahan
(`gh api repos/<o>/<r>/issues/<n> --jq .id`) sebelum panggilan aslinya. Skill
sudah menyebutkannya di `issue-tracker-github.md:42`, tapi kalau permukaan tulis
dipindah ke control plane, control plane yang harus menanggung round-trip itu.

Batas tambahan dari deskripsi `sub_issue_id`: sub-issue **harus milik owner repo
yang sama** dengan parent. Map dan tiketnya tidak bisa tersebar lintas owner.

### 5.3 Jebakan kedua: `@me` dan bot App

Langkah **Claim** — *"the session's first write"* menurut
`issue-tracker-github.md:44` — ditulis sebagai:

```
gh issue edit <n> --add-assignee @me
```

`gh` menerjemahkan `@me` lewat GraphQL, bukan lewat konstanta. Sumbernya
[`cli/cli`, `api/queries_user.go`](https://github.com/cli/cli/blob/trunk/api/queries_user.go):

```go
func CurrentLoginName(client *Client, hostname string) (string, error) {
	var query struct {
		Viewer struct {
			Login string
		}
	}
	err := client.Query(hostname, "UserCurrent", &query, nil)
	return query.Viewer.Login, err
}
```

Dua kemungkinan, dua-duanya buntu:

- Kalau `viewer` gagal di bawah installation token, `@me` tidak terselesaikan dan
  perintah error. Deskripsi OpenAPI mencatat `GET /user` sebagai
  `enabledForGitHubApps: false` — endpoint REST padanan `viewer` memang tertutup
  untuk App.
- Kalau `viewer` berhasil, ia mengembalikan login **bot App** (`<app-slug>[bot]`).
  Dan bot itu tidak layak jadi assignee. Dokumentasi GitHub tentang assignee
  menyebut yang berhak: *"yourself, anyone who has commented on the issue or pull
  request, anyone with write permissions to the repository, and organization
  members with read permissions"* — bot App tidak masuk kategori mana pun.
  Skema `POST …/assignees` di OpenAPI menegaskan konsekuensinya, dan
  konsekuensinya **diam**:

  > *NOTE: Only users with push access can add assignees to an issue. **Assignees
  > are silently ignored otherwise.***

  Diam adalah bagian terburuknya. Endpoint mengembalikan 200/201, `gh` keluar
  dengan kode 0, dan tiket tidak ter-assign. Frontier query wayfinder — yang
  membuang tiket **yang punya assignee** — akan terus mengembalikan tiket yang
  sama, dan agent akan mengklaim-ulang tiket itu setiap giliran. Loop tak
  berujung yang tidak melempar error apa pun.

**Konsekuensi desain.** Claim adalah satu-satunya operasi wayfinder yang tidak
bisa dijalankan agent dengan installation token. Tiga jalan:

1. **Control plane yang meng-assign**, memakai identitas user (PAT / token user
   sungguhan). Agent tetap menulis sisanya. Ini yang paling kecil perubahannya
   terhadap mekanika wayfinder.
2. **Ganti representasi "claim"**: dari assignee menjadi label
   (`wayfinder:claimed`) atau komentar penanda. Sepenuhnya bisa dilakukan
   installation token, tapi mengubah `issue-tracker-github.md` — jadi skill tidak
   lagi "apa adanya".
3. **Assign ke user manusia yang menjalankan run**, dengan login-nya dikirim ke
   Sandbox sebagai konfigurasi, bukan diselesaikan lewat `@me`. Perlu user itu
   punya push access.

Apa pun yang dipilih: **cek hasilnya**. `POST …/assignees` tidak akan memberi tahu
kalau gagal. Endpoint `GET /repos/{o}/{r}/assignees/{assignee}`
(`enabledForGitHubApps: true`) mengembalikan `204` kalau bisa di-assign dan `404`
kalau tidak — itu satu-satunya cara memeriksa lebih dulu.

### 5.4 `gh` di bawah installation token — yang belum terjawab

Tidak terverifikasi, dan menjadi risiko yang harus dibereskan sebelum bentuk
dikunci:

- Apakah `gh issue create` / `gh issue list` (yang sebagian lewat GraphQL) bekerja
  penuh dengan `GH_TOKEN=ghs_…`. Dokumentasi GitHub menyatakan installation token
  *"will work with both the GraphQL API and the REST API"*, jadi secara prinsip
  ya — tapi `gh` melakukan pemeriksaan sendiri di beberapa jalur, dan itu belum
  diuji.
- Apakah `gh` memanggil `viewer`/`/user` di jalur lain di luar `@me` (misalnya
  saat inferensi repo atau saat menampilkan `Status`). Kalau ya, perintah yang
  seharusnya aman bisa ikut gagal.
- Perilaku `gh` saat token kedaluwarsa di tengah run. Installation token hidup
  **1 jam**. Sesi wayfinder yang panjang akan melewatinya, dan tidak ada mekanisme
  refresh di dalam `gh`.

Cara mengujinya nanti: buat GitHub App uji dengan izin `issues: read and write`,
pasang di repo sandbox, cetak installation token, lalu jalankan seluruh 13 baris
tabel §5.1 satu per satu dengan `GH_DEBUG=api` untuk melihat setiap panggilan
HTTP yang benar-benar dibuat `gh`.

---

## 6. Yang harus terdengar sekarang

Lima hal, urut menurut seberapa jauh ia mengubah bentuk:

1. **`/wayfinder` tidak jalan dalam bentuk perintah sandcastle sekarang.** Ujian
   kelulusan peta ini — "sesi seperti `/wayfinder` berjalan penuh di dalam
   factory" — gagal apa adanya. Perbaikannya di sandcastle (`-p -` → `-p`), di
   luar seam yang dipegang factory.
2. **"Skill dipakai apa adanya" berlaku di tingkat berkas, tidak di tingkat
   perilaku.** Frontmatter yang sama berarti hal berbeda per alat.
   `disable-model-invocation` dipatuhi Claude Code, diabaikan OpenCode, tidak
   dikenal Codex.
3. **Wayfinder butuh dua berkas, bukan satu.** `setup-matt-pocock-skills/issue-tracker-github.md`
   harus ikut hadir di Sandbox, atau `/wayfinder` diam-diam jatuh ke tracker
   local-markdown.
4. **Langkah Claim tidak bisa dijalankan agent dengan installation token, dan
   gagalnya diam.** Permukaan tulis tiket harus memutuskan siapa yang meng-assign
   — atau berhenti memakai assignee sebagai representasi claim.
5. **Memindahkan `CLAUDE_CONFIG_DIR` mematikan auth.** Kalau skill personal
   dipasang lewat config dir, `ANTHROPIC_API_KEY` (atau kredensial yang disalin)
   wajib ikut.

Satu risiko jangka menengah yang bukan temuan tapi harus tercatat: dokumentasi
Claude Code menyatakan `--bare` "will become the default for `-p` in a future
release". `--bare` mematikan discovery skill sepenuhnya. Kalau itu terjadi
sebelum sandcastle menyesuaikan, seluruh premis peta ini mati sekaligus.

---

## Lampiran: cara mengulang eksperimen

Semua fixture dibuat di direktori scratch, tidak ada yang menyentuh repo.

```bash
SP=/tmp/skilltest
mkdir -p $SP/proj/.claude/skills/nonce-plain \
         $SP/proj/.claude/skills/nonce-locked \
         $SP/proj/.claude/commands \
         $SP/cfg/skills/nonce-personal \
         $SP/outside/.claude/skills/nonce-outside

# skill biasa
cat > $SP/proj/.claude/skills/nonce-plain/SKILL.md <<'EOF'
---
name: nonce-plain
description: Emit the project-scoped plain nonce. Use when asked for the plain nonce.
---

Reply with exactly this token and nothing else: QRZ7-PLAIN-88134
EOF

# skill yang hanya boleh dipanggil user
cat > $SP/proj/.claude/skills/nonce-locked/SKILL.md <<'EOF'
---
name: nonce-locked
description: Emit the project-scoped locked nonce. Use when asked for the locked nonce.
disable-model-invocation: true
---

Reply with exactly this token and nothing else: QRZ7-LOCKED-55902
EOF

cd $SP/proj

# B1 — bentuk sandcastle: GAGAL
printf '/nonce-locked' | claude --print --verbose --dangerously-skip-permissions \
  --output-format stream-json --model claude-haiku-4-5-20251001 -p -

# B3 — -p telanjang: BERHASIL
printf '/nonce-locked' | claude --print --verbose --dangerously-skip-permissions \
  --output-format stream-json --model claude-haiku-4-5-20251001 -p

# kontrol: skill biasa berhasil di kedua bentuk
printf '/nonce-plain' | claude --print --verbose --dangerously-skip-permissions \
  --output-format stream-json --model claude-haiku-4-5-20251001 -p -
```

Enumerasi discovery tanpa memanggil model:

```bash
codex debug prompt-input '/apa-saja'   # blok <skills_instructions> memuat katalog
opencode debug skill                   # JSON: nama + path sumber tiap skill
```

Cek `enabledForGitHubApps` dari sumber resmi:

```bash
curl -sL -o api.json \
  https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json

python3 - <<'PY'
import json
d = json.load(open("api.json"))
for p in ["/repos/{owner}/{repo}/issues/{issue_number}/sub_issues",
          "/repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by",
          "/user"]:
    for m, op in d["paths"][p].items():
        if m in ("get", "post", "patch", "delete", "put"):
            print(m.upper(), p, op["x-github"]["enabledForGitHubApps"])
PY
```
