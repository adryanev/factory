# Perilaku jendela konteks per alat, dan apa yang bisa dikendalikan dari luar proses

Riset untuk issue #117 (bagian dari #114). Pertanyaan pokoknya: **kebijakan
padatkan/mulai-bersih lintas giliran harus netral antar alat — perilaku apa saja
yang benar-benar dijamin ketiganya?**

Jawaban singkat: **hampir tidak ada.** Satu-satunya hal yang dijamin ketiga alat
adalah bahwa jendela penuh **tidak** memunculkan sinyal terstruktur di stdout,
dan bahwa kode keluar tidak membedakan "konteks habis" dari kegagalan lain.
Semua mekanisme yang berguna — ambang compaction yang bisa diatur, penanda
compaction di berkas sesi, biaya token per giliran — ada di sebagian alat saja,
dan yang paling lemah (OpenCode) memutus tiga dari lima di antaranya sekaligus.

Daftar lengkap "yang dijamin" ada di [§8](#8-yang-dijamin-lintas-semua-alat).
Daftar "yang tidak dijamin" — bagian paling menentukan keputusan — ada di
[§7](#7-yang-tidak-dijamin-lintas-semua-alat).

> **Diamandemen oleh tiket 29 dan tiket 144.** Dokumen ini ditulis dengan
> **membaca source, tanpa menjalankan**, dan sebagian kesimpulannya sudah
> terbantah. **Baca catatan ini sebelum memakai §1, §2, atau §3.**
>
> **Tiga temuan gugur** ([tiket 29](https://github.com/adryanev/factory/issues/132),
> diuji dengan menjalankan):
>
> 1. **§2.4 — "dokumentasi tidak menyatakan apakah hook menyala di mode `-p`"**:
>    hook Claude Code **menyala** di `-p`. `SessionStart`, `UserPromptSubmit`,
>    `PreToolUse`, `Stop`, `SessionEnd`, `PreCompact`, dan `PostCompact` semuanya
>    menyala di headless, dan `PreCompact` **bisa memblokir** kompaksi proaktif.
> 2. **§2.4 — "Codex: ada gerbang trust"** benar, tapi tidak lengkap: Codex punya
>    sistem hook **penuh** lewat `$CODEX_HOME/hooks.json`, yang riset ini tidak
>    periksa karena hanya menelusuri jalur `-c` yang memang untrusted.
> 3. **§2.4 — "OpenCode: tidak ada padanan hook PreCompact"**: OpenCode punya
>    **dua** hook kompaksi, satu membawa `overflow: boolean`. Karena itu
>    kesimpulan *"tidak ada alat yang menjamin sinyal kompaksi"* benar **hanya
>    untuk stdout**, bukan secara umum.
>
> **Enam koreksi tambahan** dari [tiket 144](https://github.com/adryanev/factory/issues/144),
> yang menguji klaim dokumen ini dengan menjalankan alatnya — termasuk bahwa
> `model_context_window` Codex berlaku pada **95%** dari nilai yang disetel, bahwa
> pemeriksaan mid-turn Codex memakai **konteks aktif** dan bukan total kumulatif,
> dan bahwa Claude Code membawa penanda mesin **`terminal_reason: "blocking_limit"`**
> yang melengkapi §2.3. Rinciannya di
> [`non-interferensi-harness.md` §8](./non-interferensi-harness.md#8-koreksi-untuk-jendela-konteks-per-alatmd).

---

## 0. Cakupan, versi, dan sumber

Factory hanya memegang seam `startTurn(spec)`, dan `startTurn` memanggil
sandcastle. Jadi yang relevan **hanya mode non-interaktif**, persis dalam bentuk
perintah yang dibangun sandcastle 0.12.0:

| Alat | Perintah yang dibangun sandcastle | Sumber |
| --- | --- | --- |
| Claude Code | `claude --print --verbose --dangerously-skip-permissions --output-format stream-json --model <m> [--effort e] [--resume <id>] [--fork-session] -p -`, prompt lewat stdin | `src/AgentProvider.ts:1213` |
| Codex | `codex exec [resume\|fork <id>] --json --dangerously-bypass-approvals-and-sandbox -m <m> [-c model_reasoning_effort="e"] [-]`, prompt lewat stdin | `src/AgentProvider.ts:811` |
| OpenCode | `opencode run --format json --model <m> [--variant v] [--agent a] [--dangerously-skip-permissions] "<prompt>"`, prompt lewat argv | `src/AgentProvider.ts:981` |

Perilaku TUI (slash command `/compact`, meteran konteks di layar) **tidak**
relevan kecuali disebut secara eksplisit di bawah — dan di ketiga alat ia
memang tidak tersedia di mode non-interaktif.

Versi yang dibaca:

- **sandcastle** `v0.12.0`, tag di `github.com/mattpocock/sandcastle`, commit
  `e99f832`. Semua path `src/...` di dokumen ini relatif terhadap root repo itu.
  Paket npm yang terpasang di repo ini (`node_modules/.pnpm/@ai-hero+sandcastle@0.12.0/`)
  hanya berisi `dist/` hasil build, jadi pembacaan dilakukan di repo sumber pada
  tag yang sama.
- **Claude Code**: dokumentasi resmi `code.claude.com/docs/en/*` per Agustus 2026,
  ditambah bukti langsung dari berkas transkrip lokal yang ditulis Claude Code
  **v2.1.221** (field `version` di dalam entri JSONL).
- **Codex CLI**: repo `github.com/openai/codex`, tag `rust-v0.147.0`, commit
  `be6e8eac0` (`codex-rs/Cargo.toml` → `version = "0.147.0"`).
- **OpenCode**: repo `github.com/sst/opencode`, branch `dev` commit
  `e23586af2`, `packages/opencode/package.json:3` → **1.18.18**. **Ini bukan tag
  rilis** — klon dangkal membuang tag. Angka OpenCode di dokumen ini perlu
  diverifikasi ulang terhadap versi biner yang benar-benar terpasang di image
  runner.

**Catatan versi yang penting**: repo factory belum memaku versi CLI mana pun
(tidak ada Dockerfile runner yang memasang `claude`/`codex`/`opencode`;
`deploy/images/` hanya berisi control-plane). Selama versi belum dipaku, semua
temuan di bawah adalah snapshot, bukan kontrak.

---

## 1. Apa yang terjadi saat jendela penuh

### 1.1 Claude Code

Auto-compaction **menyala secara default** dan berlaku sama di mode `-p`;
dokumentasi tidak membedakan headless dari interaktif untuk pemicu compaction.

- "Claude Code compacts automatically as you approach the limit, so a full
  context window doesn't end your session" —
  <https://code.claude.com/docs/en/context-window>
- Ambang default: "If you don't set an auto-compact window, Claude Code compacts
  when the conversation reaches the model's context limit", dengan pengecualian
  per-model (Sonnet 4.6/Opus 4.6 tanpa extended context di batas 200K; Sonnet 5
  di ~967K dari jendela 1M) —
  <https://code.claude.com/docs/en/model-config#default-auto-compact-thresholds>
  dan <https://code.claude.com/docs/en/model-config#sonnet-5-context-window>
- **Persentase pemicu default tidak didokumentasikan.** Yang ada hanya kaitnya:
  `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` "can't raise the threshold, so values above
  the default percentage are ignored" — <https://code.claude.com/docs/en/env-vars>
  (baris tabel `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`). Jadi ada persentase default,
  tapi angkanya tidak diumumkan.
- Kalau compaction dimatikan, atau kalau compaction sendiri gagal, giliran
  berakhir dengan galat teks `Prompt is too long`, atau
  `Prompt is too long · automatic compaction failed: <galat>` —
  <https://code.claude.com/docs/en/errors#prompt-is-too-long>

### 1.2 Codex

Auto-compaction **menyala secara default** dan **tidak bisa dimatikan**.

- Ambang: `ModelInfo::auto_compact_token_limit()` mengembalikan
  `(context_window * 9) / 10` — yaitu **90% jendela** — dan setiap nilai yang
  dikonfigurasi di-`min()` terhadap angka itu
  (`codex-rs/protocol/src/openai_models.rs:466-476`).
- Keputusan diambil di `codex-rs/core/src/session/context_window.rs:74-79`:
  `token_limit_reached = auto_compact_scope_tokens >= buffered_auto_compact_limit || full_context_window_limit_reached`.
  Suku kedua (`active >= model_context_window`) tidak bisa dilewati konfigurasi
  apa pun.
- Dipicu di dua titik, keduanya di `codex-rs/core/src/session/turn.rs`: pre-turn
  sebelum permintaan sampling pertama (`turn.rs:988-1007`) dan mid-turn setelah
  tiap respons model (`turn.rs:422-462`).
- **Riwayat memang dibuang diam-diam di dua tempat.** (a) Loop retry compaction
  lokal memanggil `history.remove_first_item()` lalu mencoba lagi, tanpa event
  apa pun (`codex-rs/core/src/compact.rs:304-311`). (b) Jalur remote v2 memotong
  ekor pesan yang dipertahankan ke anggaran tetap
  `RETAINED_MESSAGE_TOKEN_BUDGET = 64_000`
  (`codex-rs/core/src/compact_remote_v2.rs:60` dan `:455`).
- Kalau compaction sendiri tidak menyelamatkan, `ApiError::ContextWindowExceeded`
  membatalkan giliran (`codex-rs/codex-api/src/sse/responses.rs:390-397`,
  `turn.rs:1375-1379`) → `turn.failed` → keluar dengan kode 1.

### 1.3 OpenCode

Auto-compaction **menyala secara default**, berjalan di loop prompt bersama
(`SessionPrompt.runLoop`) yang sama untuk `run` maupun TUI.

- Ambang **bukan persentase**, melainkan penyangga absolut:
  `COMPACTION_BUFFER = 20_000` di `packages/opencode/src/session/overflow.ts:8`;
  `usable()` di `overflow.ts:10-25`; `isOverflow()` di `overflow.ts:27-33`
  membandingkan total token terhadap `usable`.
- Dua jalur pemicu: (a) ambang token setelah sebuah step
  (`packages/opencode/src/session/processor.ts:477-482`), (b) provider
  mengembalikan galat context-length (413 / `context_length_exceeded`),
  diklasifikasi di `packages/opencode/src/provider/error.ts:168-171` dan
  ditangkap di `processor.ts:607-617`.
- Pemulihan pada jalur (b) adalah **replay**: pesan user terakhir dipotong keluar
  lalu disisipkan lagi setelah ringkasan, dengan lampiran media diturunkan jadi
  placeholder teks (`packages/opencode/src/session/compaction.ts:340-356` dan
  `:468-495`).
- Kalau compaction sendiri tidak muat, `ContextOverflowError` dipasang ke pesan
  ringkasan dan loop berhenti (`compaction.ts:450-459`).

---

## 2. Apakah kejadiannya terlihat dari luar proses

Ini bagian yang paling menentukan, dan jawabannya berbeda di tiap alat **dan**
berbeda antara "apa yang CLI keluarkan" versus "apa yang sandcastle teruskan".

### 2.1 Aliran stdout

| Alat | Ada event compaction di stdout? | Apakah sandcastle meneruskannya? |
| --- | --- | --- |
| Claude Code | Ada di aliran pesan SDK: pesan boundary dengan `subtype: "compact_boundary"` (`SDKCompactBoundaryMessage` di TypeScript, `SystemMessage` subtype `"compact_boundary"` di Python) — <https://code.claude.com/docs/en/agent-sdk/streaming-output> ("Message flow", paragraf "Without partial messages enabled"). Halaman headless **tidak** mengenumerasi event ini. | **Tidak.** `parseStreamJsonLine` hanya mengenali `type: "assistant"`, `type: "result"`, dan `type: "system"` dengan `subtype: "init"` (`src/AgentProvider.ts:67-121`). Baris `system`/`compact_boundary` jatuh ke `return []`. |
| Codex | **Tidak.** Enum event exec `--json` adalah `ThreadEvent` di `codex-rs/exec/src/exec_events.rs:9-37`, dan isinya persis: `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.started`, `item.updated`, `item.completed`, `error`. Core memang punya `ThreadItem::ContextCompaction` (`codex-rs/app-server-protocol/src/protocol/v2/item.rs:393-395`) dan notifikasi `thread/compacted` (`.../common.rs:1749`), tapi pemeta exec membuang keduanya lewat catch-all di `codex-rs/exec/src/event_processor_with_jsonl_output.rs:311` dan `:586`. | Tidak ada yang bisa diteruskan. |
| OpenCode | **Tidak ada sinyal bersih.** Event `session.compacted` ada di skema (`packages/schema/src/session-compaction-event.ts`, diterbitkan di `compaction.ts:554`), tapi loop `run` tidak pernah mencocokkannya. Daftar `type` yang benar-benar dikeluarkan `run --format json` adalah enam string, ditulis tangan di `packages/opencode/src/cli/cmd/run.ts:678-691`: `tool_use`, `step_start`, `step_finish`, `text`, `reasoning`, `error`. | Sandcastle mengenali `step_start`, `text`, `tool_use`, `error` (`src/AgentProvider.ts:895-936`) — `step_finish` diabaikan. |

**Yang lebih buruk dari sekadar "tidak terlihat" di OpenCode**: giliran compaction
berjalan lewat `SessionProcessor` yang sama dan menulis part `step-start`,
`step-finish`, dan `text` pada `sessionID` yang sama; loop `run` menyaring
**hanya** berdasarkan `sessionID` (`run.ts:717`). Akibatnya **teks ringkasan
compaction keluar sebagai event `text` biasa** dan tercampur dengan keluaran
agent. Untuk sandcastle, `text` juga dipetakan jadi `result` (`src/AgentProvider.ts:901-911`)
dan Orchestrator memakai "result terakhir menang" — jadi ringkasan compaction
bisa menjadi hasil giliran.

Satu sinyal yang tersedia di OpenCode, tapi menyesatkan: pada jalur pemicu (b),
`processor.ts:615-616` menerbitkan `Session.Event.Error` **walaupun pemulihan
berhasil**, sehingga `run` mengeluarkan `{"type":"error","error":{"name":"ContextOverflowError",...}}`
dan **tetap menyetel `process.exitCode = 1`** (`run.ts:837`). Compaction yang
sukses terlihat persis seperti run yang gagal.

### 2.2 Berkas sesi tersimpan

Di sini keadaannya jauh lebih baik — untuk dua dari tiga alat.

**Claude Code — penanda ada dan kaya.** Diverifikasi langsung dari transkrip
lokal `~/.claude/projects/-Users-adryanev-Code-personal-factory/351e2f1e-…jsonl`
(ditulis Claude Code v2.1.221). Bentuk persisnya:

```json
{"parentUuid":null,"logicalParentUuid":"d0876ce0-…","isSidechain":false,
 "type":"system","subtype":"compact_boundary","content":"Conversation compacted",
 "level":"info",
 "compactMetadata":{"trigger":"manual","preTokens":200841,"postTokens":14642,
   "cumulativeDroppedTokens":186199,"durationMs":141168,
   "preCompactDiscoveredTools":[…],
   "preservedSegment":{"headUuid":"…","anchorUuid":"…","tailUuid":"…"},
   "preservedMessages":{…}},
 "uuid":"853c2e06-…","timestamp":"…","version":"2.1.221"}
```

Ringkasannya sendiri ditulis sebagai entri berikutnya, `type: "user"` dengan
`isCompactSummary: true` dan `parentUuid` menunjuk ke UUID baris boundary.
Jadi ada **dua** penanda independen yang bisa dipakai factory, dan
`compactMetadata.preTokens` / `postTokens` / `cumulativeDroppedTokens` langsung
memberi angka yang selama ini hanya bisa ditebak.

**Peringatan resmi**: "The entry format is internal to Claude Code and changes
between versions, so scripts that parse these files directly can break on any
release" — <https://code.claude.com/docs/en/sessions>. Field-field di atas
**tidak** didokumentasikan; mereka terverifikasi secara empiris di v2.1.221 saja.

**Codex — penanda ada dan dijamin persisten.** `RolloutItem::Compacted`
diserialisasi dengan `#[serde(tag = "type", content = "payload", rename_all = "snake_case")]`
menjadi `{"type":"compacted","payload":{…}}`
(`codex-rs/protocol/src/protocol.rs:3207-3219`; bentuk persisnya diuji di
`codex-rs/protocol/src/compacted_item.rs:62-81`). `CompactedItem` membawa
`message`, `replacement_history`, `window_number`, `first_window_id`,
`previous_window_id`, `window_id` (`protocol.rs:3243-3258`). Baris ini **selalu**
ditulis apa pun mode riwayatnya (`codex-rs/rollout/src/policy.rs:15-19`).

**OpenCode — penanda ada, tapi di SQLite, bukan JSONL.** Sesi disimpan di
basis data `~/.local/share/opencode/opencode.db`
(`packages/core/src/database/database.ts:43-55`), tabel `session`/`message`/`part`
(`packages/core/src/session/sql.ts:22-98`). Buktinya adalah kombinasi tiga hal:
sebuah baris `part` dengan `data.type == "compaction"`
(skema `CompactionPart` di `packages/schema/src/v1/session.ts:195-202`), plus
pesan asisten induknya dengan `data.summary == true`, `data.finish` terisi, dan
`data.error` kosong (`packages/schema/src/v1/session.ts:470`,
`compaction.ts:398-401`). Ketiganya harus dicek: compaction yang gagal
meninggalkan `summary: true` **dengan** `error`, dan riwayat tidak jadi dipotong
(`packages/opencode/src/session/message-v2.ts:540-541`).

**Tapi ini tidak berguna lewat sandcastle**, karena sandcastle tidak
mengambil sesi OpenCode sama sekali — lihat §5.

### 2.3 Kode keluar

Ketiganya: **hanya 0 dan bukan-0, tanpa kode khusus untuk konteks habis.**

- Claude Code: "Claude Code exits with code 0 on success and a non-zero code when
  the run fails" — <https://code.claude.com/docs/en/headless>. Tidak ada kode
  khusus yang didokumentasikan. (SIGTERM → 143, itu satu-satunya kode spesifik
  yang disebut.)
- Codex: `error_seen` → `std::process::exit(1)` di `codex-rs/exec/src/lib.rs:1029-1031`;
  semua jalur gagal lain juga 1.
- OpenCode: `process.exitCode = 1` di `run.ts:832, 837, 851, 868`; tidak ada kode
  khusus.

### 2.4 Hook sebagai kanal observasi

Dua alat punya hook `PreCompact`; satu tidak.

- **Claude Code**: hook `PreCompact` ada, input JSON membawa `session_id`,
  `transcript_path`, `cwd`, `hook_event_name`, dan matcher `"manual"` /
  `"auto"` — <https://code.claude.com/docs/en/hooks>. **Dokumentasi tidak
  menyatakan apakah ia menyala di mode `-p`.** Tidak ada pengecualian
  headless yang disebut, tapi itu inferensi, bukan jaminan.
- **Codex**: hook `PreCompact` / `PostCompact` ada
  (`codex-rs/config/src/hook_config.rs:36-46`), menyala di keempat implementasi
  compaction, dengan payload `PreCompactCommandInput { session_id, turn_id,
  transcript_path, cwd, hook_event_name, model, trigger }`
  (`codex-rs/hooks/src/schema.rs:343-358`), `trigger` = `"auto"` | `"manual"`
  (`codex-rs/core/src/hook_runtime.rs:803-808`). **Tapi ada gerbang trust**: hook
  yang datang dari layer `-c` berstatus untrusted dan tidak didaftarkan kecuali
  `--dangerously-bypass-hook-trust` ikut dipasang
  (`codex-rs/hooks/src/engine/discovery.rs:562-568`, `:684`) — dan sandcastle
  tidak pernah memasang flag itu.
- **OpenCode**: tidak ada padanan hook PreCompact yang ditemukan.

---

## 3. Apa yang bisa dikendalikan dari luar proses

Factory hanya memegang argv (lewat opsi provider sandcastle), env, dan berkas
konfigurasi yang bisa di-mount ke dalam sandbox. Sandcastle **memang** memberi
jalur env: tiap provider menerima `options.env` yang digabung di
`mergeProviderEnv` (`src/mergeProviderEnv.ts:26-30`, dipanggil dari
`src/run.ts:618-626`). Jadi env var adalah pengungkit yang paling langsung.

### 3.1 Claude Code

**Matikan sepenuhnya — bisa.**

| Pengungkit | Bentuk | Efek | Sumber |
| --- | --- | --- | --- |
| `DISABLE_AUTO_COMPACT=1` | env | Matikan auto-compaction; `/compact` manual tetap ada. Menimpa setting `autoCompactEnabled`. | <https://code.claude.com/docs/en/env-vars> |
| `DISABLE_COMPACT=1` | env | Matikan **semua** compaction, otomatis maupun manual. | <https://code.claude.com/docs/en/env-vars> |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | env, integer polos 100000–1000000 | Setel ukuran jendela auto-compact. Menang atas `/autocompact`, flag `--autocompact`, dan setting `autoCompactWindow`. `500k` terbaca `500` lalu di-clamp ke minimum 100K. | <https://code.claude.com/docs/en/env-vars> |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | env, 1–100 | Setel persentase jendela saat compaction menyala. **Hanya bisa menurunkan**; nilai di atas default diabaikan. | <https://code.claude.com/docs/en/env-vars> |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | env | Deklarasikan ukuran jendela yang diasumsikan. Untuk ID model yang diawali `claude-`, ini **hanya berlaku bila `DISABLE_COMPACT` juga disetel**. | <https://code.claude.com/docs/en/model-config#correct-the-window-for-a-gateway-or-custom-model-id> |
| `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` | env | Tahan model berjendela 1M native ke 200K. | <https://code.claude.com/docs/en/env-vars> |
| `autoCompactEnabled` (default `true`), `autoCompactWindow` | settings.json | Padanan setting dari dua env pertama. | <https://code.claude.com/docs/en/settings> |
| `--autocompact <auto\|tokens>` | flag CLI | Setel jendela untuk satu peluncuran. **Sandcastle tidak membangunnya** (`src/AgentProvider.ts:1190-1216`), jadi tidak terjangkau lewat seam. | <https://code.claude.com/docs/en/cli-reference> |

**Paksa dari luar** — tidak jelas. Halaman headless menyatakan skill dan custom
command bekerja di `-p`, dan menyebut nama command builtin yang bekerja
(`/model`, `/effort`, `/fast`, `/color`, `/rename`, `/mcp`, `/config`).
**`/compact` tidak ada di daftar itu**, dan `/compact` bukan skill —
<https://code.claude.com/docs/en/headless> (catatan di bagian "Create a commit").
Jadi memaksa compaction lewat prompt di mode `-p` **tidak terkonfirmasi**.

### 3.2 Codex

**Matikan sepenuhnya — tidak bisa.** Ini fakta keras.

- Dalam scope default (`total`), berapa pun `model_auto_compact_token_limit`
  yang disetel akan di-`min()` ke 90% jendela
  (`codex-rs/protocol/src/openai_models.rs:466-476`) — hanya bisa diturunkan.
- Bahkan dengan `model_auto_compact_token_limit_scope=body_after_prefix` dan
  limit raksasa, suku `full_context_window_limit_reached` tetap memaksa
  compaction (`codex-rs/core/src/session/context_window.rs:74-79`).
- Hook `PreCompact` yang mengembalikan `should_stop` **tidak** melewatkan
  compaction — ia mematikan giliran dengan `CodexErr::TurnAborted`
  (`codex-rs/core/src/compact.rs:184-198`).
- **Tidak ada env var yang memengaruhi compaction atau jendela konteks.**
  Satu-satunya env yang relevan adalah `CODEX_HOME`, yang memindahkan lokasi
  `$CODEX_HOME/sessions/…` (`codex-rs/rollout/src/recorder.rs:1556`).

Yang bisa: **menurunkan ambang** lewat override `-c`. Kunci yang relevan:

| Kunci | Default | Efek | Sumber |
| --- | --- | --- | --- |
| `model_auto_compact_token_limit` | tidak diset | Ambang compaction, di-clamp ke 90% jendela | `codex-rs/models-manager/src/model_info.rs:35-37`, `core/src/config/mod.rs:646` |
| `model_auto_compact_token_limit_scope` | `total` | `total` atau `body_after_prefix` | `core/src/config/mod.rs:650`, `core/src/session/context_window.rs:37-50` |
| `model_context_window` | katalog model | Timpa ukuran jendela, di-clamp ke `max_context_window` | `models-manager/src/model_info.rs:26-34`, `core/src/config/mod.rs:643` |
| `tool_output_token_limit` | tidak diset | Anggaran pemotongan keluaran tool | `models-manager/src/model_info.rs:38-50` |
| `compact_prompt` | tidak diset | **Hanya dibaca jalur compaction lokal** (`core/src/compact.rs:115-117`); dengan provider OpenAI jalur default adalah remote v2 yang tidak pernah membacanya — kunci ini inert | `config/src/config_toml.rs:239` |

Dokumentasi resmi mengonfirmasi dua kunci pertama:
<https://learn.chatgpt.com/docs/config-file/config-reference>.

**Masalahnya untuk factory: sandcastle tidak menyediakan jalan untuk mengoper
`-c` sembarang.** `CodexOptions` hanya punya `effort`, `env`, `captureSessions`,
`sessionStorage`, `approvalsReviewer` (`src/AgentProvider.ts:749-771`), dan
`buildPrintCommand` hanya membangun `-c model_reasoning_effort=…` dan
`-c approvals_reviewer=…` (`src/AgentProvider.ts:787-797`). Satu-satunya jalan
tersisa adalah menulis `config.toml` ke `$CODEX_HOME` di dalam sandbox lewat
hook `onSandboxReady`, dan menyetel `CODEX_HOME` lewat `options.env`.

**Paksa dari luar** — tidak ada. `Op::Compact` ada di protokol
(`codex-rs/protocol/src/protocol.rs:656`) tapi `codex exec` tidak pernah
mengirimkannya. `/compact` adalah slash command TUI
(`codex-rs/tui/src/slash_command.rs:40`); `exec` tidak mem-parse slash command
sama sekali, jadi prompt `"/compact"` dikirim apa adanya ke model sebagai teks.

### 3.3 OpenCode

**Matikan sepenuhnya — bisa, dan ini yang paling mudah dari ketiganya.**

| Pengungkit | Bentuk | Efek | Sumber |
| --- | --- | --- | --- |
| `OPENCODE_DISABLE_AUTOCOMPACT=1` | env | Paksa `compaction.auto = false` | `packages/core/src/flag/flag.ts:28`, `packages/opencode/src/config/config.ts:579-581` |
| `OPENCODE_DISABLE_PRUNE=1` | env | Paksa `compaction.prune = false` | `flag.ts:25`, `config.ts:582-584` |
| `OPENCODE_CONFIG_CONTENT` | env, JSON inline | Suntik konfigurasi penuh tanpa menyentuh berkas — jalur paling langsung untuk `{"compaction":{…}}` dan `{"provider":{…}}` | `flag.ts:22`, `config.ts:468-476` |
| `OPENCODE_CONFIG` | env, path | Berkas konfigurasi tambahan | `flag.ts:21` |
| `compaction.auto` | config, default `true` | Nyala/mati | `packages/core/src/v1/config/config.ts:151-153` |
| `compaction.reserved` | config, default `min(20_000, maxOutputTokens)` | Penyangga token yang dicadangkan | `config.ts:164-166`, dipakai di `overflow.ts:15` |
| `compaction.prune` | config, default `false` | Bersihkan keluaran tool lama | `config.ts:154-156` |
| `provider.<id>.models.<id>.limit.{context,input,output}` | config | Timpa ukuran jendela. `context` dan `output` **wajib** bersama | `packages/core/src/v1/config/provider.ts:47-53` |

Kalau auto-compaction dimatikan, overflow nyata muncul sebagai
`ContextOverflowError` pada pesan asisten dengan `finish = "error"`
(`processor.ts:608-613`) → event `error` → keluar 1.

**Paksa dari luar** — tidak bisa dari `opencode run`. Tidak ada command builtin
`compact` (registri hanya `{INIT:"init", REVIEW:"review"}` di
`packages/opencode/src/command/index.ts:45`); `/compact` adalah entri slash TUI
(`packages/tui/src/routes/session/index.tsx:562-585`). Pemicu sesungguhnya
adalah `POST /session/:sessionID/summarize`, yang hanya terjangkau lewat server
HTTP yang berjalan — bentuk invocation yang berbeda dari yang dipakai sandcastle.

### 3.4 Ringkasan pengungkit

| | Matikan auto-compact | Turunkan ambang | Naikkan ambang | Paksa compact |
| --- | --- | --- | --- | --- |
| Claude Code | **Ya** (`DISABLE_AUTO_COMPACT` / `DISABLE_COMPACT`) | Ya (`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`) | Sebagian (`CLAUDE_CODE_AUTO_COMPACT_WINDOW` naik, tapi PCT tidak bisa naik) | Tidak terkonfirmasi |
| Codex | **Tidak, dengan cara apa pun** | Ya (`-c model_auto_compact_token_limit`, tapi sandcastle tidak menyediakan jalurnya) | **Tidak** (di-clamp ke 90%) | Tidak |
| OpenCode | **Ya** (`OPENCODE_DISABLE_AUTOCOMPACT`) | Ya (`compaction.reserved`) | Ya (`compaction.reserved` kecil / `limit.context` besar) | Tidak |

---

## 4. Bentuk resume

### 4.1 Claude Code

`--resume <id>` membaca transkrip dari
`~/.claude/projects/<cwd-terkode>/<session-id>.jsonl` dan memulihkan riwayat
percakapan penuh termasuk tool call dan hasilnya, ditambah model, agent,
permission mode. Ia **tidak** memulihkan `--mcp-config`, `--settings`,
`--plugin-dir`, atau `--add-dir` — flag itu harus dioper ulang —
<https://code.claude.com/docs/en/sessions#what-a-resumed-session-restores>.

`--fork-session` membuat session ID baru alih-alih memakai ulang yang lama, jadi
berkas JSONL baru lahir di direktori yang sama —
<https://code.claude.com/docs/en/sessions#branch-a-session>.

**Bisa dibedakan sudah ter-compact atau belum: ya**, lewat baris
`{"type":"system","subtype":"compact_boundary",…}` dan/atau entri
`{"type":"user","isCompactSummary":true,…}` (§2.2). Dua penanda, redundan satu
sama lain. Tapi ingat peringatan resmi bahwa format ini internal dan bisa
berubah tiap rilis.

### 4.2 Codex

Berkas rollout: `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDThh-mm-ss-<uuid>.jsonl`
(`codex-rs/rollout/src/recorder.rs:1549-1578`, didokumentasikan di
`codex-rs/rollout/src/list.rs:422`). **Peringatan untuk pembungkus**: berkas bisa
terkompresi zstd sebagai `rollout-….jsonl.zst`
(`codex-rs/rollout/src/compression.rs:18`).

`codex exec resume <id>` **tidak** memutar ulang seluruh berkas. Ia memindai dari
yang terbaru ke terlama, dan pada `RolloutItem::Compacted` pertama yang membawa
`replacement_history`, ia mengadopsi itu sebagai basis dan mempersempit replay ke
segala sesuatu setelahnya (`codex-rs/core/src/session/rollout_reconstruction.rs:181-186`).

`resume` menambahkan ke berkas yang sama dengan thread id yang sama
(`codex-rs/rollout/src/recorder.rs:873-874`); `fork` membuat berkas dan id baru
dengan `SessionMeta.forked_from_id` mencatat garis keturunannya
(`codex-rs/protocol/src/protocol.rs:3085`).

**Bisa dibedakan: ya**, lewat baris `{"type":"compacted","payload":{…}}`, dan
`payload.window_number` bahkan memberi hitungan jendela compaction yang sudah
lewat (`codex-rs/core/src/session/mod.rs:3249`).

**Jebakan resume**: `resolve_resume_thread_id` mengembalikan UUID apa adanya
tanpa cek keberadaan; tapi **nama non-UUID yang tidak resolve mengembalikan
`Ok(None)`, dan exec lalu diam-diam memulai thread baru** alih-alih gagal
(`codex-rs/exec/src/lib.rs:797-812`, `:1499-1501`). Sandcastle memakai session id
UUID, jadi jalur ini tidak kena — tapi ia adalah jenis kegagalan senyap yang
patut diketahui.

### 4.3 OpenCode

`opencode run` **mendukung** resume lewat `--session`/`-s`, `--continue`/`-c`,
dan `--fork` (`packages/opencode/src/cli/cmd/run.ts:147-160`). Pemulihan
**bukan** replay penuh: sumber pesan satu-satunya adalah
`MessageV2.filterCompactedEffect` (`packages/opencode/src/session/prompt.ts:1092-1094`),
yang berjalan dari baru ke lama dan **berhenti di batas compaction**
(`packages/opencode/src/session/message-v2.ts:521-541`), lalu menyusun ulang agar
ekor duduk setelah ringkasan (`message-v2.ts:542-570`).

**Bisa dibedakan: ya secara prinsip** (§2.2), tapi lewat query SQLite terhadap
`~/.local/share/opencode/opencode.db`, bukan lewat membaca satu berkas JSONL.

**Tapi tidak lewat sandcastle** — lihat §5.1.

---

## 5. Apa yang sandcastle 0.12.0 seragamkan, sembunyikan, dan patahkan

### 5.1 Yang ia patahkan: OpenCode tidak resumable sama sekali

`opencode` provider dideklarasikan dengan `captureSessions: false` dan **tanpa**
`sessionStorage` (`src/AgentProvider.ts:959-998`). Konsekuensinya berlapis:

- `assertResumeSessionExists` melempar `"opencode does not support resumeSession"`
  (`src/resumePrecheck.ts:30-32`, dipanggil dari `src/run.ts:587-593`). Ini
  **gagal keras, bukan senyap** — bagus.
- Orchestrator melewati blok capture sesi seluruhnya
  (`src/Orchestrator.ts:507-512`), jadi tidak ada berkas sesi yang disimpan ke
  host, jadi tidak ada blob yang bisa factory simpan dan pulihkan.
- Artinya: **premis "sesi disimpan ke blob dan dipulihkan tiap giliran" tidak
  berlaku untuk OpenCode di sandcastle 0.12.0.** Sesi grilling 20+ giliran
  lintas hari tidak bisa dijalankan dengan OpenCode melalui seam ini. Ini bukan
  soal kebijakan compaction; ini soal apakah alatnya bisa dipakai sama sekali.

### 5.2 Yang ia patahkan: `codex exec fork` tidak ada di Codex 0.147.0

Sandcastle membangun `codex exec fork <id>` ketika `forkSession` disetel
(`src/AgentProvider.ts:802-808`), dan ADR 0018-nya menyebut `codex exec fork`
sebagai flag fork native Codex
(`docs/adr/0018-fork-is-session-only.md`, bagian "Decision").

Di Codex `rust-v0.147.0`, `codex exec` hanya punya dua subcommand:

```rust
// codex-rs/exec/src/cli.rs:147-154
pub enum Command {
    /// Resume a previous session by id or pick the most recent with --last.
    Resume(ResumeArgs),
    /// Run a code review against the current repository.
    Review(ReviewArgs),
}
```

`fork` adalah subcommand **top-level** yang berujung ke TUI
(`codex-rs/cli/src/main.rs:196-197`, difinalisasi menjadi `TuiCli` di
`main.rs:2534-2559`). Dokumentasi non-interaktif resmi juga hanya mencantumkan
`codex exec` dan `codex exec resume` —
<https://learn.chatgpt.com/docs/non-interactive-mode>.

Jadi `RunResult.fork()` pada provider Codex akan gagal parsing clap di versi ini.
Kegagalannya keras (kode keluar bukan-0), bukan senyap. **Saya tidak bisa
memastikan kapan perubahan ini terjadi** — klon dangkal membuang riwayat, jadi
tidak bisa dibedakan antara "pernah ada lalu dihapus" dan "tidak pernah ada".
Yang pasti: pada versi yang saya baca, ia tidak ada.

### 5.3 Yang ia seragamkan: `IterationUsage`

Sandcastle memaksa satu bentuk usage berbentuk-Claude:

```ts
// src/AgentProvider.ts:226-231
export interface IterationUsage {
  readonly inputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly outputTokens: number;
}
```

Codex dipetakan ke bentuk itu di `parseCodexUsage`
(`src/AgentProvider.ts:681-697`): karena Codex melaporkan `input_tokens` sebagai
total prompt dan `cached_input_tokens` sebagai subsetnya, sandcastle memetakan
bagian tercache ke `cacheReadInputTokens` dan sisanya ke `inputTokens` agar
`inputTokens + cacheCreation + cacheRead` tidak menghitung ganda. Tampilan
"Context window: NNNk" dihitung dari jumlah ketiganya
(`src/run.ts:198-204`).

**Ini penyeragaman bentuk, bukan penyeragaman makna** — lihat §6.

### 5.4 Yang ia sembunyikan

- **Event compaction Claude Code.** `parseStreamJsonLine` membuang setiap baris
  `system` yang bukan `subtype: "init"` (`src/AgentProvider.ts:110-116`).
- **`step_finish` OpenCode**, yang membawa satu-satunya angka token OpenCode
  (`src/AgentProvider.ts:938`, komentar "step_finish, tool output, etc. → skip").
- **Perbedaan resume-vs-fork** ditutupi di balik satu opsi boolean
  `forkSession`, padahal semantik berkasnya berbeda di tiap alat.

### 5.5 Yang ia batasi

- `resumeSession` **tidak boleh** dikombinasikan dengan `maxIterations > 1`
  (`src/run.ts:534-540`). Untuk grilling multi-giliran, artinya satu `run()` per
  giliran — yang memang bentuk `startTurn(spec)`.
- `resumeSession` hanya berlaku pada iterasi pertama
  (`src/Orchestrator.ts:381-383`).
- Transfer sesi menulis ulang field `cwd` dari path sandbox ke path host dan
  sebaliknya (`src/SessionStore.ts:153-185`), termasuk `session_meta.payload.cwd`
  milik Codex. Baris JSON yang rusak (writer terbunuh saat flush) dipertahankan
  apa adanya agar sisa sesi selamat (`SessionStore.ts:163-164, 180-182`).

---

## 6. Apakah biaya token per giliran bisa dibaca seragam

**Tidak.** Ini gejala yang paling ingin dipakai factory untuk menebak jendela
hampir penuh, dan ia yang paling tidak seragam.

| Alat | Ada di `IterationResult.usage`? | Apa artinya sebenarnya |
| --- | --- | --- |
| Claude Code | Ya, dari `parseSessionUsage` — mengambil `message.usage` dari entri `type: "assistant"` **terakhir** di transkrip (`src/AgentProvider.ts:1238-1262`) | Usage satu pesan asisten terakhir. Untuk Claude, `input_tokens + cache_creation + cache_read` pada pesan itu **mendekati ukuran konteks aktif** saat pesan itu dikirim. Ini proksi persen-penuh yang paling dekat dari ketiganya. |
| Codex | Ya, dari event stream `turn.completed` (`src/AgentProvider.ts:738-742`) | **Kumulatif, bukan ukuran konteks.** Pemeta exec membaca `usage.total.*`, bukan `usage.last.*` (`codex-rs/exec/src/event_processor_with_jsonl_output.rs:117-128`), dan `total_token_usage` adalah penjumlahan berjalan (`codex-rs/protocol/src/protocol.rs:2122-2125`). Ia **tidak direset oleh compaction** dan **terbawa lintas resume** (`codex-rs/core/src/session/mod.rs:1492-1497`). Angka yang benar-benar memicu compaction (`History::get_total_token_usage`) tidak pernah dikeluarkan ke stdout. |
| OpenCode | **Tidak.** `undefined` selalu. | OpenCode sebenarnya melaporkan usage lengkap per step di `step_finish` (`packages/schema/src/v1/session.ts:240-256`: `tokens.{input,output,reasoning,cache.read,cache.write,total}` plus `cost`), tapi parser sandcastle melewatinya dan tidak ada `parseSessionUsage` untuk provider ini. |

**Ukuran jendela konteks tidak dilaporkan oleh satu pun dari ketiganya** dalam
aliran keluaran non-interaktif:

- Claude Code: tidak ada field ukuran jendela di stream-json (tidak ada di
  enumerasi manapun di <https://code.claude.com/docs/en/headless>).
- Codex: `model_context_window` ada di `ThreadTokenUsage`
  (`codex-rs/app-server-protocol/src/protocol/v2/thread.rs:1605`) tapi pemeta
  exec tidak menyalinnya ke `Usage` (`event_processor_with_jsonl_output.rs:121-127`).
- OpenCode: `step_finish` bahkan tidak membawa field model; batas jendela datang
  dari `https://models.opencode.ai/api.json` (`packages/core/src/models-dev.ts:160,176`)
  dan tidak pernah muncul di keluaran JSON.

Konsekuensinya: **factory tidak bisa menghitung "persen penuh" untuk alat mana
pun tanpa menyimpan tabel ukuran jendela per model sendiri** — dan bahkan
dengan tabel itu, pembilangnya berarti tiga hal berbeda di tiga alat.

---

## 7. Yang TIDAK dijamin lintas semua alat

Ini bagian yang menentukan keputusan. Setiap butir di bawah adalah sesuatu yang
**tidak boleh** dipakai sebagai dasar kebijakan netral.

1. **Compaction tidak bisa dimatikan di mana-mana.** Codex memaksanya secara
   tak terhindarkan pada 90% jendela, atau lebih awal, dan tidak ada env var
   maupun flag yang membatalkannya
   (`codex-rs/core/src/session/context_window.rs:74-79`,
   `codex-rs/protocol/src/openai_models.rs:466-476`). Kebijakan "matikan
   auto-compact, factory yang mengurus reset" **tidak bisa diterapkan seragam**.

2. **Ambang tidak bisa dinaikkan di mana-mana.** Codex meng-clamp ke 90%; Claude
   Code tidak mengizinkan `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` naik di atas default.
   Hanya OpenCode yang bisa dinaikkan bebas.

3. **Kejadian compaction tidak terlihat di stdout di mana pun yang berguna.**
   Codex membuangnya di pemeta exec. OpenCode tidak pernah mencocokkannya. Claude
   Code punya `compact_boundary` di aliran SDK, tapi sandcastle membuangnya.
   Nol dari tiga yang bisa dipakai apa adanya.

4. **Penanda "sudah ter-compact" di sesi tersimpan tidak seragam bentuknya, dan
   satu alat tidak menyimpan sesi sama sekali lewat sandcastle.** Claude Code:
   `subtype: "compact_boundary"` + `isCompactSummary` di JSONL (tidak
   didokumentasikan, format internal yang bisa berubah tiap rilis). Codex:
   `{"type":"compacted"}` di JSONL rollout (terdokumentasi di source, dijamin
   persisten). OpenCode: baris SQLite yang butuh tiga field dicek bersamaan —
   **dan sandcastle tidak pernah mengambilnya**.

5. **Biaya token per giliran tidak punya makna yang sama.** Claude Code ≈ ukuran
   konteks aktif; Codex = jumlah kumulatif lintas semua request dan lintas
   resume, tidak direset compaction; OpenCode = tidak ada sama sekali lewat
   sandcastle. **Menggunakan `IterationResult.usage` sebagai gejala jendela
   hampir penuh hanya sah untuk Claude Code.**

6. **Ukuran jendela konteks tidak dilaporkan alat mana pun**, jadi "persen penuh"
   tidak bisa dihitung dari keluaran proses saja.

7. **Kode keluar tidak membedakan "konteks habis" dari kegagalan lain** di alat
   mana pun. Lebih buruk: di OpenCode, compaction yang **berhasil** lewat jalur
   galat provider tetap menyetel exit code 1 (`run.ts:837`) — pulih terlihat
   seperti gagal.

8. **Compaction tidak bisa dipaksa dari luar di alat mana pun.** Codex: tidak
   ada jalur sama sekali dari `exec`. OpenCode: hanya lewat HTTP API server yang
   berjalan. Claude Code: `/compact` di prompt `-p` tidak terkonfirmasi bekerja.

9. **Resume tidak tersedia di semua alat.** OpenCode tidak resumable lewat
   sandcastle 0.12.0 (§5.1). Ini memutus premis dasar "sesi disimpan ke blob dan
   dipulihkan tiap giliran".

10. **Riwayat bisa hilang diam-diam tanpa compaction terjadi.** Codex membuang
    item riwayat tertua satu per satu dalam loop retry compaction lokal
    (`codex-rs/core/src/compact.rs:304-311`) dan memotong ekor ke 64.000 token
    di jalur remote v2 (`codex-rs/core/src/compact_remote_v2.rs:60`, `:455`),
    keduanya tanpa event apa pun. OpenCode memotong keluaran tool pada
    `tool_output.max_lines`/`max_bytes` saat menulis
    (`packages/core/src/v1/config/config.ts:136-148`).

11. **Hook `PreCompact` bukan kanal yang bisa diandalkan.** Codex punya, tapi
    hook dari layer `-c` untrusted dan butuh `--dangerously-bypass-hook-trust`
    yang tidak dibangun sandcastle
    (`codex-rs/hooks/src/engine/discovery.rs:562-568`). Claude Code punya, tapi
    dokumentasi tidak menyatakan ia menyala di `-p`. OpenCode tidak punya.

---

## 8. Yang DIJAMIN lintas semua alat

Daftarnya pendek. Kebijakan netral hanya boleh bersandar pada ini:

1. **Mode non-interaktif ada, menerima satu prompt, menghasilkan keluaran
   JSONL baris-per-baris ke stdout, lalu keluar.**
2. **Jendela penuh tidak mematikan proses.** Ketiganya memadatkan otomatis
   secara default, bukan gagal — Claude Code
   (<https://code.claude.com/docs/en/context-window>), Codex
   (`codex-rs/core/src/session/turn.rs:988-1007`), OpenCode
   (`packages/opencode/src/session/processor.ts:477-482`).
3. **Compaction menyala secara default di ketiganya**, tanpa perlu konfigurasi.
4. **Tidak ada satu pun alat yang menjamin sinyal compaction di stdout.** Yang
   dijamin adalah ketiadaan sinyal yang bisa diandalkan, bukan ketiadaan sinyal
   sama sekali: OpenCode jalur (b) memang mengeluarkan
   `{"type":"error","error":{"name":"ContextOverflowError"}}` yang diteruskan
   sandcastle sebagai `result` (§2.1) — tapi jalur (a) senyap, dan event itu
   juga muncul saat pemulihan **berhasil**, jadi ia tidak bisa dipakai sebagai
   penanda.
5. **Kode keluar hanya membedakan sukses dari gagal**; tidak ada kode khusus
   untuk konteks habis di ketiganya.
6. **Setiap alat menerima env var dari luar proses** — dan sandcastle
   memberikan jalur untuk itu lewat `options.env` pada tiap provider
   (`src/mergeProviderEnv.ts:26-30`, `src/run.ts:618-626`). Ini satu-satunya
   pengungkit konfigurasi yang tersedia seragam.
7. **Mekanisme utama pemotongan riwayat di ketiganya adalah ringkasan
   (summarize-and-replace)**, jadi setelah compaction giliran berikutnya tetap
   punya konteks berupa ringkasan, bukan konteks kosong. **Ini bukan jaminan
   bahwa tidak ada riwayat yang hilang diam-diam** — Codex tetap membuang item
   tertua satu per satu di jalur fallback compaction lokal dan memotong ekor ke
   64.000 token di jalur remote v2; lihat §7 butir 10.

Perhatikan bahwa butir 4 dan 5 adalah jaminan **negatif**: yang dijamin adalah
ketiadaan sinyal yang bisa diandalkan, bukan keberadaannya.

---

## 9. Implikasi untuk kebijakan padatkan/mulai-bersih

Fakta-fakta di atas memaksa kebijakan menjadi kasar. Ini konsekuensi langsung,
bukan rekomendasi desain — keputusannya milik ticket #123.

- **Kebijakan tidak bisa reaktif terhadap kejadian compaction**, karena tidak
  ada alat yang melaporkannya lewat kanal yang sandcastle teruskan (§7 butir 3).
  Kebijakan harus **proaktif**: memutuskan sebelum giliran, bukan bereaksi
  sesudahnya.
- **Kebijakan tidak bisa memakai persen-penuh**, karena pembilangnya bermakna
  beda dan penyebutnya tidak dilaporkan (§7 butir 5 dan 6). Yang tersisa sebagai
  gejala netral adalah hal-hal yang factory hitung sendiri: jumlah giliran,
  jumlah byte prompt yang dikirim, jumlah byte keluaran yang diterima, dan
  ukuran berkas sesi tersimpan.
- **Kebijakan tidak bisa mengandalkan "matikan auto-compact lalu factory yang
  mengurus"**, karena Codex tidak bisa dimatikan (§7 butir 1). Compaction alat
  akan tetap terjadi; kebijakan factory berjalan **di atas** compaction alat,
  bukan menggantikannya.
- **Deteksi "sudah pernah ter-compact" hanya bisa per-alat**, dengan adapter
  terpisah untuk Claude Code (grep `"subtype":"compact_boundary"` di JSONL) dan
  Codex (grep `"type":"compacted"` di rollout JSONL) — dan tidak ada untuk
  OpenCode selama sandcastle tidak menangkap sesinya.
- **OpenCode perlu keputusan tersendiri sebelum apa pun yang lain**: dengan
  sandcastle 0.12.0 ia tidak bisa dipakai untuk langkah grilling multi-giliran
  sama sekali (§5.1). Pilihannya: keluarkan OpenCode dari alat yang didukung
  untuk langkah ini, atau tambahkan `sessionStorage` untuk OpenCode ke
  sandcastle (upstream atau fork).

---

## 10. Batas riset ini

Yang **tidak** diverifikasi dan patut dicek sebelum keputusan dikunci:

- **Tidak ada satu pun CLI yang dijalankan.** Semua klaim perilaku CLI berasal
  dari pembacaan source atau dokumentasi resmi. Bentuk JSONL Codex dan OpenCode
  disimpulkan dari source, bukan diamati.
- **Query SQLite OpenCode di §2.2 tidak dijalankan** terhadap basis data nyata.
- **Versi OpenCode yang dibaca adalah `dev` HEAD (1.18.18), bukan tag rilis.**
  Angka-angkanya bisa berbeda pada versi yang benar-benar terpasang.
- **Apakah `compact_boundary` benar-benar muncul di stdout `claude --print
  --output-format stream-json` tidak dikonfirmasi secara empiris.** Ia
  terdokumentasi untuk aliran pesan lengkap SDK
  (<https://code.claude.com/docs/en/agent-sdk/streaming-output>), dan halaman
  headless tidak mengenumerasinya. Untuk factory ini tidak mengubah kesimpulan —
  sandcastle membuangnya apa pun jawabannya — tapi ia relevan kalau factory
  suatu saat memanggil `claude` langsung.
- **Apakah hook `PreCompact` Claude Code menyala di mode `-p` tidak terkonfirmasi.**
- **Kapan `codex exec fork` hilang (atau apakah ia pernah ada) tidak bisa
  ditentukan** dari klon dangkal.
- **Versi CLI di image runner belum dipaku di repo ini**, jadi semua temuan
  adalah snapshot terhadap versi yang disebut di §0.
