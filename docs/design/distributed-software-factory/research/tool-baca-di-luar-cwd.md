# Tool baca dan tool jelajah di luar cwd — apakah tiap alat menjangkaunya?

Riset untuk issue [#151](https://github.com/adryanev/factory/issues/151) (bagian dari #114).

**Jawaban singkat.** Ya, keempat alat menjangkau path di luar cwd — tapi **satu
di antaranya terkunci sampai sebuah flag membukanya**, dan flag itu kebetulan
sudah dikirim sandcastle. **OpenCode** menolak baca di luar cwd tanpa
`--dangerously-skip-permissions`; gerbangnya bernama `external_directory` dan
ia nyata, bukan dugaan. **Codex** tidak punya tool baca sama sekali — ia membaca
lewat `shell`, dan sandbox-nya sendiri sudah mengizinkan baca ke seluruh
filesystem bahkan sebelum sandcastle mematikannya. **pi** tidak punya penahan
apa pun. **Cursor** tidak bisa diuji di mesin ini dan tetap yang paling lemah
buktinya.

Dan ditemukan satu jebakan yang lebih berbahaya daripada penguncian, karena ia
tidak punya gerbang untuk dibuka: **`glob` milik OpenCode mengembalikan
`"No files found"` untuk pattern berupa path absolut** — bukan galat, bukan
penolakan, melainkan daftar kosong yang tidak bisa dibedakan dari "memang tidak
ada berkasnya". Model yang menaruh path absolut blok penunjuk ke dalam `pattern`
— yang persis dilakukannya saat tidak dituntun — akan menyimpulkan knowledge
repo kosong. Claude Code tidak punya masalah ini.

Dan **tidak satu pun penolakan baca naik ke orkestrator**, di keenam provider,
karena tidak satu pun parser sandcastle membaca hasil tool. Ini jaminan negatif
yang sebentuk dengan temuan gambar [#117](https://github.com/adryanev/factory/issues/117).

**Satu koreksi terhadap riset sebelumnya**: catatan
[`gambar-di-jalur-prompt.md`](gambar-di-jalur-prompt.md) menyebut
`--dangerously-skip-permissions` sebagai *"flag yang tidak ada di opencode
1.18.15"*. Flag itu **ada** — ia hanya tidak muncul di `--help`, dan ia adalah
satu-satunya alasan pembacaan di luar cwd bekerja untuk OpenCode di bawah
sandcastle hari ini.

---

## 0. Metode dan batas riset

**Aturan bukti**: tiap temuan ditandai **Verified** (dijalankan sendiri, atau
dibaca langsung dari source/biner) atau **Inference** (disimpulkan, termasuk
dari dokumentasi resmi yang tidak bisa saya jalankan).

Bentuk uji, sama untuk tiap alat yang terpasang, meniru uji sesi
[#119](https://github.com/adryanev/factory/issues/119):

- cwd = repo git kosong di `<scratchpad>/uji/cwd-repo` (satu commit, satu
  `README.md`).
- Target di **luar** cwd: `<scratchpad>/uji/luar/knowledge/` berisi
  `produk.md` (token `NEBULA-8823`), `sub/penagihan.md` (token `KUARSA-5517`),
  dan `sub/lain.md` sebagai pengecoh. Token acak supaya jawaban dari ingatan
  model mustahil.
- Dua hal diuji terpisah: **baca berkas tunggal di path absolut**, dan
  **jelajah/cari pohon di luar cwd** tanpa dituntun nama berkasnya.
- Perintah persis bentuk yang dibangun sandcastle 0.12.0 (§1).
- Model termurah yang tersedia; ini uji jangkauan tool, bukan uji kecerdasan.

**Yang terpasang di mesin ini** (`which`): `codex` (codex-cli 0.147.0),
`opencode` (1.18.15), `claude` (2.1.233). **Tidak terpasang**: `pi`, dan
`cursor-agent` — juga tidak `agent`, yang adalah nama biner yang sebenarnya
dipanggil sandcastle untuk Cursor.

| Alat | Status bukti |
|---|---|
| Claude Code 2.1.233 | **Empiris**, dijalankan |
| OpenCode 1.18.15 | **Empiris**, dijalankan + source `sst/opencode` tag `v1.18.15` |
| Codex 0.147.0 | **Empiris untuk lapis sandbox dan lapis kebijakan** (`codex sandbox`, `codex debug prompt-input`, `strings` biner). **Bukan empiris untuk giliran penuh** |
| pi 0.73.1 | **Bukan empiris** — source dari tarball npm `@mariozechner/pi-coding-agent@0.73.1` |
| Cursor | **Bukan empiris** — dokumentasi resmi saja |

Kenapa Codex tidak diuji sebagai giliran penuh: akun ChatGPT di mesin ini
menolak **setiap** model yang dicoba (`gpt-5.6-sol`, `gpt-5-codex`,
`gpt-5.1-codex`, `gpt-5.1-codex-mini`, `gpt-5.1`, `codex-mini-latest`) dengan
`400 invalid_request_error: model is not supported when using Codex with a
ChatGPT account`. Hambatan yang sama dilaporkan riset #115. Tapi untuk
pertanyaan tiket ini itu tidak fatal, karena jangkauan baca Codex **bukan sifat
model**: ia ditentukan oleh kebijakan sandbox dan oleh tool apa yang ada, dan
keduanya bisa diperiksa tanpa satu pun token dibelanjakan (§2.2).

**Batas yang harus dinyatakan**: semua uji berjalan di **macOS host**, bukan di
dalam container Linux yang dipakai Sandbox. Untuk Codex ini berarti sandbox
yang diuji adalah **seatbelt** (macOS), bukan **landlock** (Linux) — kebijakan
yang dinyatakan sama, implementasinya tidak. Repo juga tidak mem-pin versi CLI,
jadi ini potret versi yang terpasang hari ini, bukan kontrak.

---

## 1. Perintah yang sandcastle kirim, dan tuas izin di dalamnya

Diambil dari source TypeScript yang diekstrak dari `sourcesContent` di
`dist/*.js.map` paket npm `@ai-hero/sandcastle@0.12.0` terpasang di repo ini.
**Verified.**

| Provider | Perintah print-mode | Tuas izin yang ikut terkirim |
|---|---|---|
| `claudeCode` | `claude --print --verbose --dangerously-skip-permissions --output-format stream-json --model <m> -p -` | `--dangerously-skip-permissions` |
| `codex` | `codex exec --json --dangerously-bypass-approvals-and-sandbox -m <m>` | `--dangerously-bypass-approvals-and-sandbox` (**tanpa syarat**) |
| `pi` | `pi -p --mode json --model <m>` | tidak ada — pi tidak punya |
| `opencode` | `opencode run --format json --model <m> --dangerously-skip-permissions <prompt>` | `--dangerously-skip-permissions` |
| `cursor` | `agent --print --output-format stream-json --model <m> --force <prompt>` | `--force` |

`dangerouslySkipPermissions` bernilai `true` di setiap jalur berjalan yang
memakai Sandbox (`Orchestrator.ts:143`, `createSandbox.ts:631`;
`createWorktree.ts:434` dan `interactive.ts:398` memberinya
`resolvedSandbox.tag !== "none"`). Jadi flag itu **selalu** terkirim untuk
factory. Codex berbeda bentuk: bypass-nya dijahit langsung ke string perintah
dan tidak bergantung pada bendera itu sama sekali —
`approvalsFlags` hanya berubah kalau `approvalsReviewer === "auto_review"`
dipilih pemanggil, yang factory tidak pilih.

Komentar di `AgentProvider.ts` menyatakan niatnya terang, dan itu tulang
punggung seluruh temuan di bawah:

> `-s danger-full-access` disables Codex's own filesystem sandbox — **Sandcastle
> owns that boundary**.

---

## 2. Per alat

### 2.1 Claude Code 2.1.233 — menjangkau, termasuk `Glob` dan `Grep`

Riset #119 sudah membuktikan baca dan jelajah. Yang ditambahkan di sini adalah
perilaku `Glob`/`Grep` terhadap **path absolut**, karena di situlah OpenCode
gagal dan perbandingannya jadi berarti.

Uji: empat panggilan tool ditentukan di prompt, `Bash` dilarang lewat
`--disallowedTools Bash` supaya alat benar-benar memakai tool jelajahnya
sendiri. **Verified**, hasil apa adanya:

| Panggilan | Hasil |
|---|---|
| `Glob{pattern:"**/*.md"}` | `README.md`, `dalam/tanda.md` — relatif cwd, benar |
| `Glob{pattern:"<luar>/**/*.md"}` (**absolut**) | ketiga berkas di luar cwd, benar |
| `Glob{pattern:"**/*.md", path:"<luar>/knowledge"}` | ketiga berkas di luar cwd, benar |
| `Grep{pattern:"Token penagihan", path:"<luar>/knowledge"}` | `sub/penagihan.md:1:Token penagihan: KUARSA-5517` |

Baca berkas tunggal di path absolut juga benar (`Read` mengembalikan
`Token penagihan: KUARSA-5517`). **Verified.**

Dua catatan kecil yang terlihat saat uji dan layak dicatat karena keduanya
memakan giliran:

- **`Read` atas sebuah direktori gagal** dengan `EISDIR: illegal operation on a
  directory`. Ia bukan pengganti `ls`. **Verified.**
- Galat "berkas tidak ada" menyebut cwd: *"File does not exist. Note: your
  current working directory is `<cwd>`."* Kalimat itu **memancing kesimpulan
  yang salah** — pada satu run model membacanya sebagai isyarat bahwa ia
  terkurung di cwd, padahal berkas yang dicarinya memang tidak ada. **Verified.**

### 2.2 Codex 0.147.0 — tidak punya tool baca; yang menentukan hanya sandbox

**Codex tidak punya tool `read`, `glob`, `grep`, atau `list` sama sekali.**
Daftar handler tool di dalam biner (`strings` atas
`/opt/homebrew/Caskroom/codex/0.147.0/bin/codex`, path source yang ikut
ter-embed):

```
apply_patch.rs   current_time.rs   dynamic.rs        extension_tools.rs
get_context_remaining.rs           mcp.rs            mcp_resource.rs
multi_agents_common.rs             multi_agents_spec.rs
new_context_window.rs              plan.rs           request_permissions.rs
request_plugin_install.rs          request_user_input.rs
shell.rs         sleep.rs          tool_search.rs    view_image.rs
wait_for_environment.rs
```

**Verified.** Baca dan jelajah keduanya lewat `shell` (`view_image` untuk
gambar, `apply_patch` untuk tulis). Konsekuensinya: **"cakupan tool" bukan
kandidat penjelas untuk Codex** — kalau ia terkunci, yang menguncinya pasti
sandbox atau kebijakan izin, tidak ada kemungkinan ketiga.

Dan sandbox-nya tidak menguncinya. `codex debug prompt-input` merender daftar
input yang benar-benar dilihat model. Dijalankan dengan cwd = repo uji, **tanpa
flag bypass apa pun** — yaitu justru konfigurasi yang lebih ketat daripada yang
sandcastle kirim:

```
<permission_profile type="managed">
  <file_system type="restricted">
    <entry access="read"><special>:root</special></entry>
    <entry access="write"><path><cwd></path></entry>
    <entry access="write"><special>:slash_tmp</special></entry>
    …
```

dan prosa developer message di giliran yang sama:

> `sandbox_mode` is `workspace-write`: The sandbox **permits reading files**, and
> editing files in `cwd` and `writable_roots`.

**Verified.** `access="read"` atas `:root` adalah seluruh akar filesystem.
Biner menyatakan hal yang sama sekali lagi di prompt reviewer `auto_review`
yang ter-embed di dalamnya: *"The coding-agent is running in a sandbox. The
sandbox allows it **read access everywhere**, and write access in its writable
root."* **Verified.**

Dan kebijakan itu diuji dengan menjalankannya, bukan dengan membacanya. `codex
sandbox` menjalankan perintah di bawah profil seatbelt Codex yang sama —
lagi-lagi tanpa flag bypass, cwd = repo uji:

| Perintah | Hasil |
|---|---|
| `codex sandbox -- cat <luar>/knowledge/produk.md` | `Token knowledge produk: NEBULA-8823` |
| `codex sandbox -- ls <luar>/knowledge` | `produk.md`, `sub` |
| `codex sandbox -- ls /Users/adryanev/.codex` | `AGENTS.md`, `auth.json`, `config.toml`, … |
| `codex sandbox -- sh -c 'echo x > ~/uji-tulis-luar.txt'` | `Operation not permitted` |

**Verified.** Baca menembus ke mana saja termasuk `$HOME`; tulis di luar cwd
diblokir. Baris terakhir adalah kontrol yang membuktikan sandbox-nya memang
menyala saat tiga baris pertama lolos.

Jadi untuk Codex jawabannya berlapis dua, dan **keduanya "ya"**: bahkan di
sandbox default ia baca ke mana saja, dan sandcastle mematikan sandbox itu
seluruhnya. Tidak ada tuas yang perlu ditarik.

Harga yang harus dinyatakan, karena ini yang membuat `context:` bekerja: **ini
juga berarti Codex membaca `~/.codex/auth.json` dan seisi `$HOME` tanpa
hambatan.** Yang menahan itu di factory bukan Codex, melainkan batas Sandbox
milik sandcastle — persis yang komentar source itu klaim.

### 2.3 OpenCode 1.18.15 — satu-satunya yang benar-benar terkunci

Ini temuan utama tiket ini.

OpenCode punya gerbang bernama **`external_directory`**, dan ia bukan efek
samping. Source `packages/opencode/src/tool/external-directory.ts` pada tag
`v1.18.15` (**Verified**, diambil lewat `gh api`):

```ts
const ins = yield* InstanceState.context
const full = process.platform === "win32" ? FSUtil.normalizePath(target) : target
if (containsPath(full, ins)) return false
…
yield* ctx.ask({
  permission: "external_directory",
  patterns: [glob],
  always: [glob],
  metadata: { filepath: full, parentDir: dir },
})
```

`glob.ts` memanggilnya (`assertExternalDirectoryEffect(ctx, search, {bypass:
false, kind: "directory"})`), dan tool `shell` juga memanggilnya untuk tiap
direktori yang disentuh perintahnya.

**Diuji dengan konfigurasi bersih** — `XDG_CONFIG_HOME` dan `XDG_DATA_HOME`
diarahkan ke direktori kosong (hanya `auth.json` disalin), supaya daftar izin
yang pernah disetujui user di mesin ini tidak mengotori hasil. Empat varian,
prompt dan model identik, **Verified**:

| Varian | Hasil `read` atas path absolut di luar cwd |
|---|---|
| tanpa flag | **`error`** — *"The user rejected permission to use this specific tool call."* |
| `--auto` | `completed`, token terbaca benar |
| `--dangerously-skip-permissions` | `completed`, token terbaca benar |
| `--flag-karangan-yang-tidak-ada` | yargs mencetak usage dan **giliran tidak pernah jalan** |

Baris keempat adalah kontrolnya, dan ia yang memaksa koreksi terhadap riset
sebelumnya. `opencode run` **strict** terhadap flag tak dikenal: flag karangan
membunuh giliran sebelum satu tool pun dipanggil. Karena
`--dangerously-skip-permissions` **tidak** membunuhnya dan justru mengubah
hasilnya, flag itu nyata. Konfirmasi ketiga langsung dari biner:

```
$ strings -a opencode.exe | grep -o "dangerously-skip-permissions"
dangerously-skip-permissions
$ strings -a opencode.exe | grep -o "dangerouslySkipPermissions"
dangerouslySkipPermissions
```

**Verified.** Ia hanya tidak didaftarkan di `opencode run --help`, yang memang
hanya menyebut `--auto` (*"auto-approve permissions that are not explicitly
denied (dangerous!)"*). Catatan `gambar-di-jalur-prompt.md` yang menyebut flag
ini *"tidak ada di opencode 1.18.15"* **salah**, dan akibatnya bukan sepele:
kalau benar tidak ada, `context:` tidak akan pernah bekerja di OpenCode.

**Ada tuas kedua, dan ia berbentuk env var** — yang penting karena
[#117](https://github.com/adryanev/factory/issues/117) menetapkan env var
sebagai satu-satunya tuas konfigurasi seragam dari seam `startTurn`. Dijalankan
**tanpa** flag apa pun, konfigurasi bersih:

```
OPENCODE_PERMISSION='{"external_directory":"allow"}' opencode run --format json --model … 
→ TOOL read completed … "Token knowledge produk: NEBULA-8823"
```

**Verified.**

Setelah gerbangnya terbuka, jelajah pun bekerja. Prompt tanpa tuntunan nama
berkas, `bash` dilarang: `grep` dengan `path` absolut menemukan
`sub/penagihan.md` beserta barisnya, `read` mengambil isinya, model menjawab
`KUARSA-5517` dengan path lengkap. **Verified.**

#### Jebakan `glob`: daftar kosong yang tidak bisa dibedakan dari direktori kosong

Pada percobaan jelajah tanpa tuntunan itu, panggilan **pertama** model adalah
`glob` dengan path absolut ditaruh di `pattern`, dan hasilnya
`"No files found"`. Ia selamat hanya karena kemudian mencoba `grep`.

Diprobe dengan empat panggilan `glob` yang ditentukan di prompt. **Verified**:

| Panggilan | Hasil |
|---|---|
| `{pattern:"**/*.md"}` | 2 berkas di cwd — benar |
| `{pattern:"<cwd>/**/*.md"}` (absolut, **di dalam** cwd) | **`No files found`** |
| `{pattern:"<luar>/**/*.md"}` (absolut, di luar cwd) | **`No files found`** |
| `{pattern:"**/*.md", path:"<luar>/knowledge"}` | 3 berkas di luar cwd — benar |

**Ini bukan penguncian cwd.** Baris kedua membuktikannya: path absolut ke
direktori cwd sendiri pun gagal. Mekanismenya terbaca di `glob.ts` v1.18.15
(**Verified**):

```ts
let search = params.path ?? ins.directory
search = path.isAbsolute(search) ? search : path.resolve(ins.directory, search)
…
const files = yield* ripgrep.glob({ cwd: search, pattern: params.pattern, limit })
…
if (files.length === 0) output.push("No files found")
```

`pattern` diserahkan ke ripgrep sebagai glob yang dicocokkan terhadap path
**relatif** di bawah `cwd: search`. Pattern absolut tidak pernah cocok dengan
apa pun, dan hasilnya bukan galat melainkan **string yang sama persis dengan
yang direktori kosong hasilkan**.

Ini bentuk kegagalan terburuk yang tiket ini cari, dan ia lebih buruk daripada
penguncian: penguncian punya gerbang yang bisa dibuka dan pesan yang bisa
dibaca; ini tidak punya keduanya. Satu-satunya penahannya adalah **model harus
memakai bidang `path`, bukan menempelkan path ke `pattern`** — dan tanpa
dituntun, model yang diuji memilih yang salah. Claude Code menerima kedua
bentuk (§2.1), jadi ini benar-benar divergensi antar alat, bukan konvensi glob
yang berlaku umum.

### 2.4 pi 0.73.1 — tidak ada penahan sama sekali

**Bukan uji empiris**; pi tidak terpasang dan tidak ada kredensial provider di
mesin ini. Source dari tarball npm `@mariozechner/pi-coding-agent@0.73.1` —
versi yang persis disebut komentar sandcastle di `AgentProvider.ts:553`.

Seluruh resolusi path pi lewat satu fungsi, `dist/core/tools/path-utils.js`:

```js
export function resolveToCwd(filePath, cwd) {
    const expanded = expandPath(filePath);
    if (isAbsolute(expanded)) {
        return expanded;          // ← lolos apa adanya, tanpa pemeriksaan
    }
    return resolvePath(cwd, expanded);
}
```

**Verified** (dibaca dari source): tidak ada pemeriksaan pembendungan — tidak
ada perbandingan terhadap cwd, tidak ada `path.relative(...).startsWith("..")`,
tidak ada apa pun. `expandPath` bahkan memuaikan `~` ke home directory.

Keempat tool yang relevan memakainya, semuanya menerima path pemanggil:

| Tool | Baris | Bentuk |
|---|---|---|
| `read` | `read.js` | `resolveReadPath(filePath, cwd)` → `resolveToCwd` |
| `find` (glob) | `find.js:100` | `resolveToCwd(searchDir \|\| ".", cwd)` |
| `grep` | `grep.js:100` | `resolveToCwd(searchDir \|\| ".", cwd)` |
| `ls` | `ls.js:74` | `resolveToCwd(path \|\| ".", cwd)` |

**Verified.** Dan tidak ada lapis izin di atasnya: pencarian
`requiresApproval|askPermission|approval` dan `sandbox` di seluruh `dist/core`
dan `dist/cli` **nol hasil**. pi tidak punya gerbang untuk ditutup maupun
dibuka. **Verified** (bukti ketiadaan, dari source).

Dua catatan operasional yang ikut terbaca dan berdampak pada `context:`:

- **`find` dan `grep` menghormati `.gitignore`** (deskripsi tool menyatakannya:
  *"Respects .gitignore"*). Untuk pohon knowledge yang disalin **tanpa `.git`**
  sesuai keputusan #119, ini seharusnya tidak menggigit — tapi ia menggigit
  kalau pohon itu masih membawa berkas `.gitignore` biasa di dalamnya.
- Argumen ripgrep yang `grep.js:136` bangun adalah
  `["--json","--line-number","--color=never","--hidden"]` — **tanpa
  `--no-ignore` dan tanpa `--no-require-git`**, sementara `find.js:170`
  memberikan `--no-require-git` ke `fd`. Keduanya tidak konsisten. **Verified**,
  akibatnya tidak diuji.

Jadi pi tidak akan gagal karena jangkauan. Kalau ia gagal, sebabnya ada di
lapis lain.

### 2.5 Cursor — bukti terlemah, dan tidak ditutup-tutupi

`cursor-agent` tidak terpasang, dan `agent` — nama biner yang sandcastle
panggil — juga tidak. **Tidak ada uji empiris.** Yang berikut seluruhnya dari
dokumentasi resmi Cursor, dan tidak menjawab pertanyaan tiket dengan tuntas.

Yang **Verified dari dokumentasi**:

- `--force` / `--yolo` — *"Force allow commands unless explicitly denied"*
  (`cursor.com/docs/cli/reference/parameters`). Ini yang sandcastle kirim.
- `--print` — *"Has access to all tools, including write and shell."*
  (sumber sama).
- Aturan izin `Read(pathOrGlob)` — *"Controls read access to files and
  directories."* Dan tentang cakupan path: ***"Relative paths are scoped to the
  current workspace"*** serta ***"Absolute paths can target files outside the
  project"*** (`cursor.com/docs/cli/reference/permissions`).
- Ada flag `--sandbox <mode>` (`enabled`/`disabled`) dan `--workspace <path>`;
  `sandbox.json` punya tipe default `workspace_readwrite`
  (`cursor.com/docs/reference/sandbox`). **Sandcastle tidak mengirim
  `--sandbox` maupun `--workspace`.**

Yang **tidak** bisa dipastikan, dan ini yang membuat Cursor tetap lubang:

1. **Apakah tool `Read` diizinkan secara bawaan tanpa prompt.** Dokumentasi
   izin menjelaskan cara menulis aturan, tidak menyebut nilai bawaannya.
2. **Apakah sandbox menyentuh tool baca atau hanya perintah shell.** Halaman
   `sandbox.json` tidak menyatakannya; halaman run-modes hanya bicara tentang
   perintah shell (*"Read and write access inside the workspace"* disebut
   sebagai perilaku sandbox **untuk perintah terminal**).
3. **Apakah `--force` mencakup baca.** Kata-katanya *"Force allow **commands**"*,
   dan kalimat itu bisa dibaca sempit.

**Inference** (dan ditandai demikian dengan sengaja): kalimat *"Absolute paths
can target files outside the project"* pada aturan `Read()` hanya masuk akal
kalau tool baca Cursor memang bisa menyentuh path di luar project — kalau tidak,
aturan yang menargetkannya tak berguna. Jadi dugaan terbaik adalah Cursor
menjangkau, dengan `--force` sebagai tuasnya. **Itu dugaan, bukan hasil uji, dan
tidak boleh dipakai sebagai dasar keputusan tanpa satu giliran sungguhan.**

---

## 3. Sub-pertanyaan 1 — symlink dari dalam worktree

Dua lapis, dan jawabannya berlawanan arah di masing-masing.

### 3.1 Lapis alat: symlink **berhasil** menyelamatkan yang terkunci

Diuji terhadap satu-satunya alat yang terbukti terkunci, OpenCode **tanpa** flag
izin (varian yang gagal di §2.3). Symlink `cwd-repo/ctx → <luar>/knowledge`
dibuat, prompt meminta baca `./ctx/produk.md`:

```
TOOL read completed  in={"filePath":".../uji/cwd-repo/ctx/produk.md"}
→ "Token knowledge produk: NEBULA-8823"
```

**Verified.** Sebabnya terbaca di source: `containsPath(full, ins)` di
`external-directory.ts` membandingkan **string path yang belum di-resolve**.
Path yang secara leksikal berada di dalam cwd lolos gerbang, walaupun ia
menunjuk keluar. Gerbang `external_directory` tidak melihat menembus symlink.

### 3.2 Lapis git: satu entri `120000`, isi tidak terangkut

Diukur dengan menjalankan git, bukan disimpulkan. Symlink ke direktori di luar
worktree, di dalam repo git. **Verified**:

```
$ git status --porcelain
?? ctx

$ git ls-files --others --exclude-standard
ctx

$ git add -A && git ls-files -s
100644 45b983be36b73c0788dc9cbcb76cbb80fc7bb057 0	README.md
120000 8c2f3c71fc0a156024e8dc177ad710d58ab79afa 0	ctx

$ git cat-file -p 8c2f3c71
/private/tmp/.../uji2/luar/knowledge
```

Jadi, menjawab persis apa yang #119 periksa untuk direktori tapi belum untuk
symlink:

- **`git ls-files --others --exclude-standard` melaporkan satu entri**, `ctx`,
  yaitu symlink itu sendiri. Ia **tidak** masuk ke dalam pohon di ujungnya.
- **`git add -A` membuat entri mode `120000`**, dan blob-nya berisi **teks path
  tujuan**, bukan isi berkas apa pun. **Isinya tidak ikut terangkut.**

Ini **lebih jinak daripada gitlink hantu `160000`** yang #119 temukan untuk repo
bersarang: `160000` menunjuk SHA yang tidak terjangkau dari repo kerja dan
memberi clone direktori kosong yang membingungkan; `120000` setidaknya jujur —
ia sebuah symlink, dan isinya terbaca. Tapi ia tetap **membocorkan path absolut
host ke dalam repo**, dan di diff PR ia satu baris.

### 3.3 Lapis pipa: dan di sinilah symlink membunuh sync-out

`git ls-files --others` melaporkan `ctx`, jadi sync-out akan mencoba
mengangkutnya. Dua fase, dan keduanya diuji.

**Fase 1** menyalin tiap entri untracked keluar dengan
`handle.copyFileOut(sandboxFilePath, hostFilePath)` (`syncOut.ts:338-352`),
yang untuk Docker adalah `docker cp` **tanpa `-L`** (`sandboxes/docker.ts:369-382`).
Diuji dengan container `alpine:3` sungguhan berisi worktree git dan symlink ke
`/ctx/knowledge`:

```
$ docker cp <c>:/wt/ctx ./out/ctx
$ ls -la ./out
ctx -> /ctx/knowledge          # symlink, bukan isinya
```

**Verified.** `docker cp` menyalin **symlink-nya**, bukan tujuannya. Yang
mendarat di host adalah symlink yang menunjuk `/ctx/knowledge` — path **di
dalam Sandbox**, yang di host tidak ada.

**Fase 2** kemudian menerapkannya dengan `readFile(srcPath)` lalu
`writeFile(destPath, content)` (`syncOut.ts:390-397`). `readFile` **mengikuti**
symlink. Diuji dengan Node 26:

| Bentuk symlink | `readFile` |
|---|---|
| → direktori | **THROW `EISDIR`** |
| → berkas biasa | OK, isi tujuan tersalin (dan mendarat di host sebagai **berkas biasa**, bukan symlink) |
| → tujuan tidak ada | **THROW `ENOENT`** |

**Verified.** Symlink `ctx → /ctx/knowledge` yang mendarat di host adalah kasus
ketiga — menggantung. `readFile` melempar `ENOENT`, blok `Effect.tryPromise`
menangkapnya, dan `failedStep = "untracked"` (`syncOut.ts:407`).

Akibatnya, dan ini yang menentukan: **seluruh langkah penyalinan untracked
gagal untuk giliran itu** — bukan hanya symlink-nya. Sandcastle lalu
mempertahankan `patchDir` dan mencetak pesan pemulihan ke `console.error`
(`syncOut.ts:423-431`). Jadi satu symlink konteks di dalam worktree
menjatuhkan pengangkutan **semua** berkas untracked yang agent tulis di giliran
itu.

### 3.4 Kesimpulan symlink

**Symlink menyelamatkan alat yang terkunci, lalu merusak pipa yang membawa
hasil kerja keluar.** Ia menukar kegagalan yang bisa dibuka lewat flag dengan
kegagalan yang tidak bisa dibuka sama sekali.

Dan pertukaran itu tidak perlu diambil: **satu-satunya alat yang terkunci
(OpenCode) sudah dibuka oleh flag yang sandcastle memang kirim** (§2.3). Jadi
rekomendasinya lugas — **jangan pakai symlink**, dan keputusan #119 (pohon di
luar worktree, path absolut disebut blok penunjuk) berdiri tanpa perlu
mitigasi ini.

Kalau kelak sebuah alat ditemukan terkunci **dan** tidak punya tuas, symlink
tetap bukan jawabannya sampai `syncOut` mengecualikan symlink dari daftar
untracked-nya — dan itu perubahan di sandcastle, bukan di factory.

---

## 4. Sub-pertanyaan 2 — apakah tuasnya seragam

**Tidak seragam bentuknya, tapi pertanyaannya sudah terjawab di tempat lain:
sandcastle sudah mengirim tuas yang tepat untuk tiap alat.**

| Alat | Terkunci? | Yang mengunci | Tuas | Sudah dikirim sandcastle? |
|---|---|---|---|---|
| Claude Code | tidak | — | — | (`--dangerously-skip-permissions` terkirim) |
| Codex | tidak | — (sandbox sendiri sudah izinkan baca `:root`) | — | (bypass sandbox terkirim) |
| OpenCode | **ya** | kebijakan izin `external_directory` | `--dangerously-skip-permissions` / `--auto` / `OPENCODE_PERMISSION` | **ya** |
| pi | tidak | — (tidak punya gerbang) | — | — |
| Cursor | tidak diketahui | tidak diketahui | `--force` (Inference) | ya |

Tiga hal yang layak dicatat dari tabel ini.

**Pertama, tidak satu pun yang terkunci oleh cakupan tool.** Yang mengunci
OpenCode adalah kebijakan izin. Yang bisa mengunci Codex adalah sandbox. Tidak
ada alat yang tool bacanya secara desain menolak path absolut. Ini menyempitkan
ruang kegagalan yang harus dijaga.

**Kedua, env var tersedia justru di alat yang membutuhkannya.** #117 menetapkan
env var sebagai satu-satunya tuas seragam dari `startTurn`, dan
`OPENCODE_PERMISSION` **Verified** bekerja. Jadi kalaupun kelak sandcastle
berhenti mengirim `--dangerously-skip-permissions` ke OpenCode, factory punya
jalan kedua yang tidak menuntut fork `AgentProvider`.

**Ketiga, ketergantungan yang harus dicatat sebagai risiko, bukan sebagai
fakta yang menenangkan.** `context:` untuk OpenCode hari ini bergantung pada
sebuah flag yang **tidak terdokumentasi di `--help`**. Flag tak
terdokumentasi bisa hilang di versi mana pun tanpa catatan rilis, dan
`opencode run` strict terhadap flag tak dikenal — jadi hilangnya flag itu tidak
akan muncul sebagai bacaan yang gagal, melainkan sebagai **giliran yang tidak
pernah jalan sama sekali**. Itu setidaknya berisik. Mitigasi termurah: kirim
`OPENCODE_PERMISSION` lewat `env` provider juga, sebagai sabuk kedua.

---

## 5. Sub-pertanyaan 3 — apakah penolakan naik ke orkestrator

**Tidak. Tidak satu pun, di keenam provider. Ini jaminan negatif, dan sebabnya
struktural: tidak ada parser sandcastle yang membaca hasil tool.**

Diperiksa di **keenam** parser di `AgentProvider.ts`. **Verified.** Tiga yang
pertama dibahas rinci di bawah; tiga sisanya menutup klaim ini:

- **pi** (`parsePiStreamLine`) hanya memetakan `session`, `message_update`,
  **`tool_execution_start`**, `agent_error`/`error`, dan `agent_end`. Yang ia
  baca dari sebuah tool adalah **peristiwa mulainya**, bukan hasilnya.
- **Copilot** (`parseCopilotStreamLine`) sebentuk: `assistant.message_delta`,
  **`tool.execution_start`**, `assistant.message`, `result`, `error`.
- **Cursor** (`parseCursorStreamLine`) menangani `tool_call` — sekali lagi
  peristiwa mulai — lalu **mendelegasikan sisanya ke `parseStreamJsonLine`**,
  yaitu parser Claude Code, yang ketiadaan pembacaan `tool_result`-nya
  dibahas di bawah. Cursor mewarisi lubang yang sama persis.

Tidak satu pun dari keenam memiliki cabang yang membaca isi atau status hasil
tool.

**OpenCode** — penolakan dibuang secara eksplisit:

```ts
if (obj.type === "tool_use" && part?.type === "tool") {
  …
  if (state?.status !== "completed") return [];   // ← status "error" → []
```

Penolakan `external_directory` yang §2.3 hasilkan tiba sebagai
`state.status === "error"` dengan pesan *"The user rejected permission to use
this specific tool call."* — dan baris di atas menjatuhkannya ke lantai.
Orkestrator tidak melihat apa pun.

**Claude Code** — parser hanya memeriksa `obj.type === "assistant"` (blok
`text` dan `tool_use`), `obj.type === "result"`, dan `system/init`. Ia **tidak
pernah** melihat pesan `user` yang membawa `tool_result`, jadi bendera
`is_error` tidak punya jalan untuk naik. Kata `is_error` tidak muncul sekali pun
di seluruh `AgentProvider.ts`.

**Codex** — parser hanya memeriksa `thread.started`,
`item.completed`+`agent_message`, `item.started`+`command_execution`,
`error` tingkat atas, dan `turn.completed`. Hasil perintah shell — termasuk
`Operation not permitted` dari sandbox — tidak dipetakan ke apa pun.

Cabang `obj.type === "error"` yang ada di parser Codex dan OpenCode **tidak
menolong**: komentarnya sendiri membatasi cakupannya — *"OpenCode emits error
events on stdout for **auth failures, rate limits, and API errors**"*. Penolakan
tool bukan salah satunya.

**Yang benar-benar terjadi**, dan diamati langsung: penolakan itu sampai ke
**model**, model menuliskannya sebagai teks biasa —

> *"Akses ditolak — path tersebut berada di luar workspace (di luar `cwd-repo`)
> dan tidak masuk daftar izin `external_directory`, jadi tool `read` diblokir
> oleh aturan permission."*

— dan teks itu dipetakan parser OpenCode menjadi `{type:"text"}` **dan**
`{type:"result"}`. Di bawah aturan "hasil terakhir menang" milik Orchestrator,
penolakan yang terjadi di tengah giliran akan **tertimpa** oleh teks apa pun
yang model tulis sesudahnya. Exit code giliran itu **0**. **Verified.**

Ini persis bentuk kegagalan yang #117 temukan untuk gambar, dan yang badan
tiket #151 prediksi: agent tidak error, ia hanya tidak pernah melihat
knowledge-nya, menjawab dari ingatan, dan Output tetap lolos skema.

**Konsekuensi untuk factory**: deteksi berbasis stream tidak tersedia dan tidak
akan tersedia tanpa mengubah sandcastle. Kalau kelak deteksi dibutuhkan,
bentuknya harus **di dalam pekerjaan itu sendiri** — misalnya blok penunjuk
yang #118 kunci menyertakan penanda yang wajib dikutip Step di `Output`-nya,
sehingga knowledge yang tak terbaca gagal di validasi skema alih-alih lolos
diam-diam. Itu keputusan desain, bukan temuan riset, dan bukan milik tiket ini.

---

## 6. Yang ini geser, dan yang tidak

**Keputusan #119 tidak berubah.** Pohon di luar worktree, tanpa `.git`, path
absolut disebut blok penunjuk — semuanya berdiri. Tidak ada alat yang menuntut
path digeser ke dalam worktree, dan symlink terbukti **memperburuk** keadaan
(§3), jadi satu-satunya mitigasi yang tiket ini pertimbangkan justru gugur.

**Tiga hal yang harus ikut ditulis kalau `context:` diimplementasikan:**

1. **OpenCode wajib membawa tuas izinnya.** Hari ini gratis karena sandcastle
   mengirim `--dangerously-skip-permissions`. Kirim `OPENCODE_PERMISSION`
   lewat `env` provider sebagai sabuk kedua, karena flag itu tidak
   terdokumentasi (§4).
2. **Blok penunjuk sebaiknya menyebut path sebagai direktori untuk dijelajahi,
   bukan sebagai pattern.** Ini murni demi jebakan `glob` OpenCode (§2.3):
   model yang menempelkan path absolut ke `pattern` mendapat `"No files found"`
   yang tak bisa dibedakan dari direktori kosong. Kalimat sependek *"pakai
   direktori ini sebagai path pencarian"* menutup satu-satunya kegagalan
   benar-benar senyap yang riset ini temukan.
3. **Cursor belum terjawab.** Ia satu-satunya dari lima yang tidak punya bukti
   apa pun selain dokumentasi, dan dokumentasinya diam soal bawaan tool baca.

---

## 7. Yang tidak diuji, dan kenapa

- **Codex sebagai giliran penuh.** Akun ChatGPT di mesin ini menolak semua
  model (§0). Lapis sandbox dan lapis kebijakan diuji sebagai gantinya, dan
  karena Codex tidak punya tool baca tersendiri (§2.2), itu menutup ruang
  penjelasnya — tapi ia tetap bukan giliran sungguhan.
- **Cursor sama sekali.** Biner tidak terpasang dan menuntut login.
- **pi sebagai giliran penuh.** Tidak ada kredensial provider di mesin ini.
  Source-nya cukup lugas (nol pemeriksaan pembendungan, nol lapis izin) sehingga
  keyakinannya tinggi, tapi ia tetap bacaan source.
- **Landlock (Linux).** Semua uji Codex memakai seatbelt macOS. Kebijakan yang
  dinyatakan sama; implementasinya berbeda, dan Sandbox berjalan di Linux.
- **Pengaruh `.gitignore` pada `find`/`grep` pi** terhadap pohon konteks
  sungguhan (§2.4).
- **Perilaku `glob` OpenCode pada pattern absolut di versi selain 1.18.15.**
- **Bentuk kegagalan OpenCode bergantung pada stdin, dan itu belum diselesaikan.**
  Uji penolakan yang pertama, dijalankan **tanpa** `</dev/null`, **menggantung
  sampai timeout 2 menit** alih-alih menolak — gerbang `external_directory`
  rupanya menunggu jawaban. Uji yang sama dengan stdin diarahkan ke `/dev/null`
  langsung menolak dan keluar dengan exit code 0. Sandcastle mengirim prompt
  OpenCode lewat **argv**, bukan stdin, jadi apa yang stdin proses itu tunjuk di
  dalam Sandbox — TTY, pipa, atau tertutup — yang menentukan factory mendapat
  giliran yang **menolak** atau giliran yang **menggantung**. Keduanya buruk
  dengan cara berbeda: yang satu senyap, yang satu menghabiskan seluruh
  anggaran waktu Step. Tidak diuji di dalam container. Ini hanya menggigit
  kalau tuas izin §2.3 hilang; hari ini tidak.
- **`copyFileIn`/`copyFileOut` untuk provider Sandbox selain Docker**
  (Podman, Daytona, Vercel) terhadap symlink. Hanya Docker yang diuji.

---

## Lampiran — perintah uji yang bisa diulang

```sh
# Fixture
mkdir -p uji/cwd-repo uji/luar/knowledge/sub
(cd uji/cwd-repo && git init -q . && echo x > README.md && git add -A && git commit -qm init)
echo "Token knowledge produk: NEBULA-8823" > uji/luar/knowledge/produk.md
echo "Token penagihan: KUARSA-5517"        > uji/luar/knowledge/sub/penagihan.md

# Codex — lapis sandbox, tanpa flag bypass apa pun
cd uji/cwd-repo
codex sandbox -- cat  ../luar/knowledge/produk.md      # terbaca
codex sandbox -- sh -c 'echo x > ~/kontrol.txt'        # Operation not permitted
codex debug prompt-input 'halo' | grep -o 'access="read"><special>:root'

# OpenCode — konfigurasi bersih, empat varian
mkdir -p oc/config/opencode oc/data/opencode
cp ~/.local/share/opencode/auth.json oc/data/opencode/
echo '{"$schema":"https://opencode.ai/config.json"}' > oc/config/opencode/opencode.json
export XDG_CONFIG_HOME=$PWD/oc/config XDG_DATA_HOME=$PWD/oc/data
P="Gunakan tool read pada path absolut $PWD/uji/luar/knowledge/produk.md lalu sebutkan tokennya."
opencode run --format json -m opencode-go/deepseek-v4-flash              "$P" </dev/null  # DITOLAK
opencode run --format json -m opencode-go/deepseek-v4-flash --auto       "$P" </dev/null  # lolos
opencode run --format json -m opencode-go/deepseek-v4-flash \
  --dangerously-skip-permissions                                          "$P" </dev/null  # lolos
OPENCODE_PERMISSION='{"external_directory":"allow"}' \
  opencode run --format json -m opencode-go/deepseek-v4-flash            "$P" </dev/null  # lolos

# Symlink — lapis git
ln -s "$PWD/uji/luar/knowledge" uji/cwd-repo/ctx
git -C uji/cwd-repo ls-files --others --exclude-standard   # → satu entri: ctx
git -C uji/cwd-repo add -A && git -C uji/cwd-repo ls-files -s | grep ctx   # → 120000

# Symlink — lapis pipa (docker cp tidak mengikuti symlink)
docker run -d --name c alpine:3 sleep 300
docker exec c sh -c 'mkdir -p /ctx /wt && echo isi > /ctx/f && ln -s /ctx /wt/ctx'
docker cp c:/wt/ctx ./keluar   # → symlink menggantung, bukan isinya
```
