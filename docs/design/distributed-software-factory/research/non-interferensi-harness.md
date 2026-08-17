# Verifikasi empiris non-interferensi tiap harness saat konteks meluap

Riset untuk issue [#144](https://github.com/adryanev/factory/issues/144) (bagian
dari #131). Tujuh klaim yang selama ini **dibaca dari source, tidak diamati**,
diuji dengan menjalankan alatnya.

Syarat non-interferensi lahir di [ticket 132](https://github.com/adryanev/factory/issues/132):
alat tidak boleh mengubah konteks rakitan factory di tengah giliran. Keputusan di
sana bersandar pada "Claude Code, OpenCode, dan pi bisa diminta diam, Codex tidak
bisa dengan cara apa pun". Riset ini memeriksa apakah kalimat itu bertahan saat
konteksnya benar-benar meluap.

---

## Jawaban singkat

**Syarat non-interferensi bertahan, tapi "bisa diminta diam" ternyata bukan satu
sifat — ia tiga sifat yang berbeda, dan hanya satu alat punya ketiganya.**

Membungkam kompaksi menjawab pertanyaan *"apakah ia mengubah konteks saya"*. Ia
tidak menjawab *"apakah saya tahu kalau giliran ini gagal"*. Ketiga alat yang
bisa dibungkam memberi jawaban berbeda untuk pertanyaan kedua, dan jaraknya jauh:

| Alat | Bisa dibungkam | Saat jendela habis dalam keadaan bungkam | Terdeteksi? |
| --- | --- | --- | --- |
| Claude Code | **Ya** | Gagal keras: `"Prompt is too long"`, `terminal_reason: "blocking_limit"`, keluar **1** | **Ya, bersih** |
| OpenCode | **Ya** | Tidak tercapai dalam uji ini; 684.636 token diterima apa adanya | Belum diketahui |
| pi | **Ya** | **Gagal senyap: keluar 0**, `stopReason: "length"`, jawaban terpotong 1 token | **Tidak** |
| Codex | **Tidak** | — (kompaksi tetap menyala) | — |

Baris pi berlaku **untuk kedua konfigurasi**: kontrol dengan kompaksi *menyala*
menghasilkan keluaran yang identik (§6), jadi cacatnya ada di bawah setelan
kompaksi, bukan di dalamnya.

**Claude Code adalah satu-satunya yang bisa dibungkam *dan* mengaku saat gagal.**
pi — yang di ticket 132 disebut "bisa diminta diam, paling tegas" dan jadi
kandidat terkuat — memang paling tegas membungkam, tapi kegagalannya **tidak
terlihat sama sekali dari luar**: keluar 0, seperti giliran sukses, dengan
jawaban yang tidak berguna. Untuk factory itu lebih berbahaya daripada Codex yang
memadatkan terang-terangan, karena Orchestrator akan menyimpan keluaran itu
sebagai hasil.

**Dari tujuh klaim: lima benar, satu meleset, satu salah.**

- **Benar**: Claude Code `DISABLE_COMPACT=1` benar-benar diam (2); OpenCode
  `OPENCODE_DISABLE_AUTOCOMPACT=1` benar-benar diam (3); Codex tidak bisa
  dibungkam walau ambangnya dinaikkan setinggi mungkin (4); rollout JSONL Codex
  bisa di-tail selagi sesi hidup (6); RPC pi melaporkan `contextWindow` dan
  `set_auto_compaction` menulis permanen ke settings global (7).
- **Meleset**: perilaku pi dengan `{"compaction":{"enabled":false}}` (1). Ramalan
  tiket adalah gagal keras sebagai `stopReason: "error"`. Yang terjadi kebalikannya
  — gagal senyap dengan keluar 0.
- **Salah**: `codex exec --json` **tidak** memancarkan `context_compacted` ke
  stdout (5). Riset [#117](https://github.com/adryanev/factory/issues/117) benar;
  inferensi #132 dari struktur enum `EventMsg` keliru.

Dua temuan yang tidak dicari tapi mengubah gambaran:

- **OpenCode bisa livelock.** Jendela yang terlalu kecil dengan auto-compaction
  menyala membuatnya memadatkan berulang kali tanpa pernah selesai — 420 detik,
  11 step, lalu dibunuh timeout. Bukan gagal, bukan selesai: menggantung.
- **Pemeriksaan mid-turn Codex memakai konteks aktif, bukan total kumulatif.**
  Satu giliran `exec` boleh memakai 100.548 token pada jendela 28.500 tanpa
  memicu kompaksi, asal tiap permintaannya sendiri tetap di bawah ambang.

---

## 0. Cakupan, versi, dan cara menguji

Semua dijalankan di mesin macOS ini, dengan kredensial langganan yang sudah ada
(tidak ada API metered yang dipakai; model gratis dipakai di mana bisa).

| Komponen | Versi | Catatan |
| --- | --- | --- |
| Claude Code | `2.1.233` | `/opt/homebrew/Caskroom/claude-code@latest/2.1.233/claude` |
| Codex | `0.147.0` | `/opt/homebrew/Caskroom/codex/0.147.0/bin/codex`; model **`gpt-5.5`** — default `gpt-5.6-sol` ditolak dengan `400 invalid_request_error`, sebab belum diisolasi (§8.6). Langganan ChatGPT mesin ini **kedaluwarsa**, tapi auth tetap melayani `gpt-5.5` normal |
| OpenCode | `1.18.15` | `/opt/homebrew/Cellar/opencode/1.18.15/bin/opencode`; provider `opencode-go`, model gratis `deepseek-v4-flash-free` |
| pi | `@earendil-works/pi-coding-agent` **0.84.2** | paket yang **hidup**; `@mariozechner/pi-coding-agent` terkonfirmasi deprecated dan beku di `0.73.1` |
| Node | `v26.5.0` | pi menuntut `>=22.19.0` |

**Cara memaksa meluap tanpa membakar token.** Tiap alat punya pengungkit untuk
mengecilkan jendela yang ia *yakini* ia punya, jadi ambangnya bisa disentuh
dengan konteks beberapa puluh ribu token, bukan sejuta:

- Claude Code: `CLAUDE_CODE_AUTO_COMPACT_WINDOW` + `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`
  untuk menurunkan ambang; `CLAUDE_CODE_MAX_CONTEXT_TOKENS` untuk menyatakan
  jendela kecil (berlaku untuk id model `claude-` **hanya bila `DISABLE_COMPACT`
  ikut disetel** — kebetulan persis kasus uji klaim 2).
- Codex: `-c model_context_window=…` dan `-c model_auto_compact_token_limit=…`.
- OpenCode: `OPENCODE_CONFIG_CONTENT` dengan `provider.opencode.models.<id>.limit`.
- pi: `compaction.reserveTokens` di `settings.json`.

**Isolasi.** Tidak ada berkas konfigurasi milik pengguna yang diubah. Codex dan
Claude Code dijalankan lewat env dan `-c` yang bersifat sesaat (persis mekanisme
yang dipakai sandcastle), dengan `cwd` di `/tmp/wf144/work` supaya transkripnya
terpisah. pi diisolasi dengan **`PI_CODING_AGENT_DIR`** — bukan `HOME`; menimpa
`HOME` membuat pi keluar dengan kode 126 tanpa keluaran apa pun.

**Catatan yang menghemat waktu orang berikutnya**: transkrip Claude Code di mesin
ini **tidak** ada di `~/.claude/projects/`, karena `CLAUDE_CONFIG_DIR` di sini
menunjuk `~/.claude-lexicon/`. Jalur yang benar diambil dari payload hook
(`transcript_path`), bukan ditebak.

---

## 1. Klaim 2 — Claude Code dengan `DISABLE_COMPACT=1` (**benar**)

Diuji dengan A/B tegas: **prompt yang sama persis** (berkas 200 KB lewat stdin,
sekitar 50.000 token), model yang sama (`haiku`), yang berubah hanya env.

Kanal pengamatannya adalah hook `PreCompact`/`PostCompact` yang dipasang lewat
`--settings` — bukan transkrip, dan ini juga mekanisme yang akan dipakai factory.

| | Kompaksi menyala (`AUTO_COMPACT_WINDOW=100000`, `PCT_OVERRIDE=30`) | `DISABLE_COMPACT=1`, `MAX_CONTEXT_TOKENS=30000` |
| --- | --- | --- |
| Kode keluar | **0** | **1** |
| `is_error` | `false` | `true` |
| `terminal_reason` | `"completed"` | **`"blocking_limit"`** |
| `result` | `"DONE"` | **`"Prompt is too long"`** |
| Hook `PreCompact` | menyala (`trigger: "auto"`) | **tidak menyala sama sekali** |

**Kesimpulan: `DISABLE_COMPACT=1` benar-benar diam.** Ia tidak memadatkan
diam-diam — hook kompaksi tidak menyala satu kali pun — dan gilirannya gagal
keras.

**Temuan tambahan yang berguna langsung**: kegagalan karena konteks membawa
**penanda mesin yang spesifik**, `terminal_reason: "blocking_limit"`, di keluaran
`--output-format json`. Ini melampaui apa yang dicatat riset sebelumnya, yang
hanya menemukan "0 dan bukan-0, tanpa kode khusus". Kode keluarnya memang tetap
1 biasa, tapi factory tidak perlu bersandar pada kode keluar: ia bisa membedakan
"konteks habis" dari galat lain tanpa mengurai teks.

**`PostCompact` tidak pernah menyala** di seluruh run Claude Code di sini,
termasuk saat `PreCompact` menyala. Pada ambang yang sangat rendah, `PreCompact`
menyala dua kali tanpa satu pun entri `compact_boundary` tertulis di transkrip —
jadi **`PreCompact` menyala sebelum kompaksi dipastikan jadi**, dan menyalanya
bukan bukti bahwa kompaksi benar-benar terjadi. Untuk factory: `PreCompact` layak
dipakai sebagai rem (ticket 132 sudah menunjukkan ia bisa memblokir), tapi
**tidak** layak dipakai sebagai penghitung kejadian kompaksi.

## 2. Klaim 3 — OpenCode dengan `OPENCODE_DISABLE_AUTOCOMPACT=1` (**benar**)

`OPENCODE_CONFIG_CONTENT` terbukti benar-benar dibaca dan divalidasi: kunci ngawur
ditolak dengan `Configuration is invalid at OPENCODE_CONFIG_CONTENT`.

**Dengan auto-compaction dimatikan, kompaksi benar-benar tidak jalan.** Prompt
2,5 MB dikirim apa adanya:

- `input: 684.636` token, `exit 0`, tanpa galat, tanpa kompaksi.

**Dengan auto-compaction menyala dan jendela dikecilkan, kompaksi memang jalan** —
tapi hanya terlihat di log debug, tidak di keluaran JSON. Run dengan
`--print-logs --log-level DEBUG` menampilkan `agent=compaction` berulang kali,
sementara `--format json` pada run yang setara hanya mengeluarkan `step_start`,
`text`, dan `step_finish`. **Ini mengonfirmasi secara empiris apa yang riset
#117 simpulkan dari source: kompaksi OpenCode tidak terlihat di stdout.**

**Temuan yang tidak dicari — livelock.** Dengan `limit.context = 30000` dan
auto-compaction menyala, run **tidak pernah selesai**: 11 `step_start`, 10
`step_finish`, 7 `tool_use`, lalu dibunuh timeout 420 detik (**kode keluar 124**).
Ia memadatkan, masih meluap, memadatkan lagi, terus-menerus. Untuk factory ini
mode kegagalan yang lebih jahat daripada gagal: Run tidak mengembalikan apa pun
dan hanya berhenti karena ada yang membunuhnya. Kalau OpenCode dipakai, lease dan
heartbeat adalah satu-satunya yang menyelamatkan.

**Batas uji ini**: jendela *sungguhan* model tidak pernah habis — 684.636 token
masih diterima provider. Jadi *"apa yang terjadi saat jendela benar-benar habis
dalam keadaan bungkam"* **belum terjawab untuk OpenCode**. Lihat §7.

## 3. Klaim 4 — Codex tidak bisa dibungkam (**benar**)

Diuji dengan `model_auto_compact_token_limit=999999999` — angka yang jauh lebih
besar dari jendela mana pun.

Butuh tiga percobaan untuk sampai ke syarat pemicunya, dan kegagalan dua percobaan
pertama itu sendiri adalah temuan:

| Run | Jendela | Bentuk | Kompaksi? |
| --- | --- | --- | --- |
| cx3 | 30000 → 28500 | prompt besar, satu giliran, tanpa tool call | **tidak** (62.294 token dipakai, 2× jendela) |
| cx5 | 30000 → 28500 | 4 tool call | **tidak** (total kumulatif 100.548) |
| cx6 | 24000 → 22800 | 4 tool call | **ya** |

**cx6 adalah buktinya**: satu baris `{"type":"compacted"}` di rollout, walau
ambang yang dikonfigurasi 999.999.999. **Clamp 90% menang.** Klaim "Codex tidak
bisa diminta diam dengan cara apa pun" bertahan.

Dua koreksi mekanis yang lahir dari cx3 dan cx5:

- **`model_context_window` diterapkan pada 95% dari yang dikonfigurasi**, konsisten
  di tiga run: 15000 → 14250, 30000 → 28500, 24000 → 22800.
- **Pemeriksaan mid-turn memakai `last_token_usage` (konteks aktif satu
  permintaan), bukan total kumulatif.** Di cx5 total tumbuh 34.237 → 54.384 →
  76.475 → 100.548 sementara tiap permintaannya 18.158 → 20.147 → 22.091 → 24.073,
  semuanya di bawah clamp 25.650 — jadi tidak ada kompaksi meski total jauh di
  atas jendela. Di cx6 clampnya 20.520 dan konteks aktif menyentuhnya, lalu
  kompaksi menyala.

Konsekuensi untuk factory, dan ini melunakkan klaim tanpa membatalkannya:
**giliran `exec` yang pendek dan tidak banyak memakai tool tidak akan memicu
kompaksi sama sekali**, karena syaratnya tidak pernah tercipta. Bahaya Codex
bukan "ia selalu memadatkan", melainkan "ia akan memadatkan begitu satu giliran
cukup panjang, dan tidak ada cara mencegahnya".

## 4. Klaim 5 — `codex exec --json` memancarkan `context_compacted` (**salah**)

Pada cx6, run yang **terbukti memadatkan**, stdout `--json` berisi persis:

```
1 thread.started   1 turn.started   4 item.started   6 item.completed   1 turn.completed
```

**Nol sebutan kata "compact"** di seluruh stdout. Tidak ada `context_compacted`,
tidak ada event kompaksi bentuk apa pun.

Inferensi #132 dari struktur enum `EventMsg` **keliru**; yang benar adalah
pembacaan riset #117 atas pemeta exec (`event_processor_with_jsonl_output.rs`),
yang membuang `ThreadItem::ContextCompaction` lewat catch-all. Kompaksi Codex
terjadi **tanpa jejak apa pun di stdout**.

## 5. Klaim 6 — rollout JSONL bisa di-tail selagi sesi hidup (**benar**)

Diuji dengan menyalakan pemantau yang mem-poll berkas rollout sekali sedetik
sambil memeriksa apakah proses Codex masih hidup:

```
COMPACTED_SEEN_AT=+16s  PROCESS_STILL_ALIVE=yes
compacted_lines=1
elapsed=27s
```

Baris `{"type":"compacted"}` muncul pada detik ke-16 dari run yang berumur 27
detik, **saat prosesnya masih berjalan**. Mode tulis append benar bisa
dimanfaatkan.

**Ini satu-satunya kanal yang memberi factory sinyal kompaksi Codex secara
langsung**, karena stdout tidak memberi apa-apa (§4) dan hook `-c` tidak
tepercaya tanpa `--dangerously-bypass-hook-trust`. Harganya: factory harus
mem-poll berkas di `$CODEX_HOME/sessions/`, bukan sekadar membaca stdout.

## 6. Klaim 1 — pi dengan `{"compaction":{"enabled":false}}` (**meleset**)

**Bagian source-nya benar.** `_checkCompaction()` dibuka persis begini
(`dist/core/agent-session.js:1510-1513`):

```js
async _checkCompaction(assistantMessage, skipAbortedCheck = true) {
    const settings = this.settingsManager.getCompactionSettings();
    if (!settings.enabled)
        return false;
```

`return` itu berada **di atas** Case 1 (`isContextOverflow`) dan di atas
pemeriksaan ambang. Jadi `enabled:false` memang mematikan **jalur ambang dan
jalur overflow sekaligus** — pi memang alat yang paling tegas bisa dibungkam.

**Bagian ramalannya meleset.** Tiket meramal giliran "gagal apa adanya sebagai
`stopReason: "error"`". Yang benar-benar terjadi, dengan prompt 900 KB (sekitar
225.000 token) pada `hy3-free` yang jendelanya 190.000:

```
exit 0
usage.input  = 196.608 token      (= 192 × 1024 — plafon sisi provider, di atas katalog)
stopReason   = "length"           (rawStopReason "length")
output       = 1 token
willRetry    = false
{"type":"agent_settled"}
```

**pi keluar 0.** Tidak ada galat, tidak ada `stopReason: "error"`. Yang keluar
adalah jawaban terpotong sepanjang satu token — sampah yang menyamar sebagai
giliran sukses.

Sebabnya: **provider memotong, tidak menolak.** Permintaan tidak ditolak dengan
galat context-length; ia diterima dengan input yang dipangkas ke 196.608 token,
dan modelnya kehabisan ruang keluaran. Dari sudut pandang pi itu henti `"length"`
yang biasa, bukan overflow.

**Dan kontrolnya menunjukkan setelan itu tidak ada bedanya di sini.** Prompt yang
sama dijalankan lagi dengan `{"compaction":{"enabled":true}}`:

```
exit 0
stopReason "length" × 3
output 1 token
{"type":"agent_settled"}
```

Hasil akhirnya **identik**: keluar 0 dengan jawaban satu token. Apakah kompaksi
benar-benar berjalan di antara tiga percobaan itu **tidak bisa diamati** —
`--mode json` tidak memancarkan satu pun event `compaction_*` dalam bentuk mana
pun yang dicoba (lihat paragraf terakhir bagian ini).

Jadi kegagalan senyap ini **bukan akibat `enabled:false`**. Pada bentuk overflow
ini — input dipotong sisi provider, bukan ditolak — **pi berakhir dengan sampah
yang tak terdeteksi entah kompaksi dinyalakan atau dimatikan**. Baris pi di tabel
ringkasan berlaku untuk kedua konfigurasi.

**Ini temuan terpenting riset ini untuk keputusan non-interferensi**, dan bentuk
tajamnya begini: membungkam pi **berhasil**, tapi keberhasilan itu tidak membeli
apa yang factory butuhkan, karena **cacatnya ada di bawah setelan kompaksi, bukan
di dalamnya**. Kalau factory memakai pi — dibungkam atau tidak — ia **wajib**
memeriksa `stopReason` dan `usage.input` sendiri di tiap giliran; kode keluar
tidak akan memberi tahu apa-apa, dan Orchestrator yang memakai "result terakhir
menang" akan menyimpan jawaban satu token itu sebagai hasil Step.

**Yang tidak berhasil diuji**: memaksa **jalur ambang** pi menyala. Empat bentuk
dicoba (dua giliran `--continue` yang menumpuk konteks, dan
`compaction.reserveTokens` dinaikkan sampai 240.000 pada jendela 256K, masing-masing
dengan `enabled` true dan false); tidak satu pun memancarkan event `compaction_*`
di `--mode json`, termasuk saat kompaksi seharusnya menyala. Jadi **A/B untuk
jalur ambang belum tuntas**: yang terbukti adalah perilaku saat overflow nyata,
bukan saat ambang tersentuh. Lihat §7.

## 7. Klaim 7 — RPC pi (**benar, keduanya**)

Diuji lewat `--mode rpc` pada direktori agent terisolasi yang kosong.

**`get_session_stats` benar mengembalikan `contextUsage.contextWindow`:**

```json
{"tokens":3904,"contextWindow":190000,"percent":2.054736842105263}
```

Angka 190.000 cocok persis dengan katalog `hy3-free`. **pi memang satu-satunya
alat yang memberi penyebut** yang dibutuhkan anggaran token per giliran — Claude
Code, Codex, dan OpenCode tidak melaporkannya lewat kanal mana pun yang dipakai
sandcastle. `pi --list-models` juga mencetak jendela tiap model.

**`set_auto_compaction` benar menulis permanen ke settings global:**

```
settings.json SEBELUM : (tidak ada)
settings.json SESUDAH : {"compaction":{"enabled":false}}
```

Cocok dengan source: `setCompactionEnabled` menulis ke `this.globalSettings` lalu
`markModified` (`dist/core/settings-manager.js:510-514`).

**Gotcha-nya terkonfirmasi dan konsekuensinya tetap berlaku**: perintah RPC ini
mengubah keadaan **global**, bukan keadaan sesi. Di dalam Sandbox bersama, satu
sesi yang memanggilnya akan mengubah perilaku semua sesi berikutnya yang memakai
direktori agent yang sama. Kalau pi dipakai, kompaksi harus dimatikan lewat
`settings.json` yang di-mount per Sandbox, **bukan** lewat `set_auto_compaction`
di tengah sesi.

Pengungkit isolasinya adalah **`PI_CODING_AGENT_DIR`** (default `~/.pi/agent`),
dan ia bekerja: seluruh tulisan mendarat di direktori scratch.

---

## 8. Koreksi untuk `jendela-konteks-per-alat.md`

Riset ini **tidak** membatalkan dokumen itu; ia menambah dan mempertajam. Tiga
temuannya yang sudah terbantah lebih dulu di ticket 132 (hook Claude Code menyala
di `-p`; Codex punya hook lewat `$CODEX_HOME/hooks.json`; OpenCode punya dua hook
kompaksi) sudah tercatat di komentar resolusi tiket itu dan tidak diulang di sini.

Yang riset ini tambahkan:

1. **§2.3 "hanya 0 dan bukan-0, tanpa kode khusus" — benar untuk kode keluar,
   tapi tidak lengkap.** Claude Code membawa penanda spesifik di badan JSON:
   `terminal_reason: "blocking_limit"` dengan `result: "Prompt is too long"`.
   Factory bisa mengenali kegagalan konteks tanpa mengurai teks galat.
2. **§3.2 — `model_context_window` diterapkan pada 95% dari nilai yang
   dikonfigurasi** (15000 → 14250, 30000 → 28500, 24000 → 22800). Angka yang
   disetel bukan angka yang berlaku.
3. **§1.2 — pemeriksaan mid-turn Codex membandingkan konteks aktif satu
   permintaan (`last_token_usage`), bukan total kumulatif giliran.** Satu giliran
   `exec` bisa memakai 100.548 token pada jendela 28.500 tanpa memicu kompaksi.
4. **§2.1 OpenCode — terkonfirmasi empiris.** Kompaksi benar-benar berjalan
   (`agent=compaction` di log debug) sementara `--format json` hanya mengeluarkan
   `step_start`/`text`/`step_finish`. Kesimpulan "tidak ada sinyal bersih" benar.
5. **§1.3 OpenCode — tambahan mode kegagalan yang tidak tercatat: livelock.**
   Jendela terlalu kecil dengan auto-compaction menyala menghasilkan kompaksi
   berulang tanpa akhir (dibunuh pada 420 detik, kode keluar 124), bukan
   `ContextOverflowError`.
6. **Codex — model default `gpt-5.6-sol` ditolak di mesin ini** dengan `400
   invalid_request_error`: *"The 'gpt-5.6-sol' model is not supported when using
   Codex with a ChatGPT account."* **Sebabnya belum diisolasi.** Bunyi pesannya
   menunjuk jenis auth (akun ChatGPT versus API key), tapi langganan ChatGPT di
   mesin ini **sedang kedaluwarsa**, jadi tingkat langganan sama masuk akalnya.
   Keduanya tidak bisa dibedakan tanpa akun kedua yang masih aktif atau API key
   pembanding. Yang **teramati** dan tidak bergantung pada sebab: Codex bisa gagal
   di permintaan pertama hanya karena model defaultnya, tanpa ada hubungannya
   dengan konteks — jadi Sandbox sebaiknya menyetel model secara eksplisit. Auth
   itu sendiri **tetap hidup**: `gpt-5.5` melayani permintaan dengan normal pada
   saat yang sama, dan seluruh hasil Codex di laporan ini memakainya.

---

## 9. Apa yang berubah untuk keputusan non-interferensi

Kalimat ticket 132 — "Claude Code, OpenCode, dan pi bisa diminta diam, Codex
tidak bisa dengan cara apa pun" — **bertahan apa adanya**. Yang berubah adalah
apa artinya bagi pilihan alat:

- **Membungkam kompaksi tidak cukup.** Syarat yang sebenarnya dibutuhkan factory
  ada dua: konteks tidak diubah, **dan** giliran yang gagal terlihat gagal. pi
  memenuhi yang pertama dan melanggar yang kedua sekeras mungkin.
- **Claude Code memenuhi keduanya**, dan memberi penanda mesin yang bersih.
- **pi tetap satu-satunya sumber `contextWindow`.** Kalau anggaran token per
  giliran jadi kebutuhan, nilai itu hanya ada di pi — tapi memakai pi menuntut
  factory memeriksa `stopReason` dan `usage.input` sendiri di tiap giliran.
- **Codex tetap tidak bisa dipakai** kalau non-interferensi mutlak yang dituntut,
  tapi bahayanya lebih sempit dari yang terbaca: hanya giliran yang cukup panjang
  yang memicunya, dan kalau ia memicu, **satu-satunya cara tahu adalah mem-poll
  rollout JSONL** — stdout tidak memberi apa pun.

---

## 10. Yang tidak diuji

Ditulis terang supaya tidak ada yang mengira sudah terjawab:

- **Jendela sungguhan OpenCode habis dalam keadaan bungkam.** 684.636 token masih
  diterima; jalur pemicu (b) (galat context-length dari provider) tidak pernah
  tercapai. Jadi apakah OpenCode gagal keras atau senyap seperti pi **belum
  diketahui**.
- **Jalur ambang pi.** Empat bentuk dicoba, tidak satu pun memancarkan event
  `compaction_*`. Yang terbukti adalah perilaku overflow nyata, bukan perilaku
  saat ambang tersentuh.
- **Jendela sungguhan Claude Code (1M) habis.** Uji memakai jendela yang
  *dideklarasikan* lewat `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, yang menyentuh
  pemeriksaan internal Claude Code sendiri — bukan penolakan dari sisi API.
- **Perilaku lewat sandcastle.** Semua dijalankan dengan memanggil CLI langsung.
  Bentuk perintah sandcastle (`-p -`, dan `CodexOptions` yang tidak menyediakan
  jalur `-c`) menambah batasannya sendiri, sebagaimana dicatat
  [`skill-di-dalam-sandbox.md`](./skill-di-dalam-sandbox.md).
- **Apakah plafon 196.608 token itu milik provider OpenCode Zen atau milik
  modelnya.** Yang teramati hanya bahwa ia memotong, bukan menolak — dan
  pemotongan diam-diam di sisi provider adalah bentuk interferensi yang tidak
  satu pun pengungkit harness bisa cegah.
