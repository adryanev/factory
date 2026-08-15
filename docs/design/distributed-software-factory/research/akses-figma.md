# Riset: Harga dan Batas Akses Figma untuk Factory — REST API vs MCP Server

Status: **SELESAI** (riset primer ke dokumentasi resmi Figma pada 2026-08-14,
seluruh tabel dibaca dari HTML mentah halaman, bukan dari ringkasan pihak
ketiga — lihat catatan metode di bawah).

Konteks: sistem CI/agent (factory) yang ingin membaca desain dari Figma
secara otomatis — mengambil isi dokumen, merender node jadi gambar, dan
membaca token/variable — tanpa manusia di depan layar.

Tanda verifikasi: **[VERIFIED-DOC]** = dibaca langsung dari halaman resmi
Figma pada tanggal riset. **[INFERENSI]** = kesimpulan yang saya tarik dari
fakta-fakta terverifikasi, bukan pernyataan eksplisit Figma.

**Metode**: tabel rate limit di `developers.figma.com` memakai `rowspan` pada
kolom Starter. Ringkasan otomatis (dan pembacaan sekilas) menggeser kolom dan
menghasilkan angka yang salah. Semua angka di laporan ini diambil dari HTML
tabel mentah dan dicek silang ke prosa halaman yang sama serta ke matriks
fitur di halaman pricing. Lihat §7 untuk bukti mentahnya.

> **Fakta yang tidak bisa dicari agent**: plan Figma yang dipakai tim
> sekarang. Seluruh kesimpulan di bawah karena itu disajikan **bersyarat per
> tier plan**. Yang perlu Anda jawab hanya satu: file desain factory ada di
> plan **Starter, Professional, Organization, atau Enterprise**?

---

## Ringkasan keputusan (bersyarat per plan)

| Plan tempat file berada | REST `GET /v1/files` + `GET /v1/images` | MCP server (remote) | Nama variable/token terbaca? | Layak untuk factory? |
|---|---|---|---|---|
| **Starter** (gratis) | **Hingga 6 permintaan per BULAN** | Hingga 20 tool call/bulan | Tidak (hanya ID) | **Tidak.** Angkanya bukan "hemat", tapi tidak bisa dipakai sama sekali |
| **Professional** ($16/bln Full, $12/bln Dev) | 10/menit (seat Dev/Full) | 200 tool call/hari, 10/menit | Tidak (hanya ID) | Ya untuk isi dokumen + render gambar; tidak untuk token |
| **Organization** ($55/bln Full, $25/bln Dev) | 15/menit (seat Dev/Full) | 200 tool call/hari, 15/menit | Tidak lewat REST (hanya ID) | Sama seperti Professional + plan access token |
| **Enterprise** ($90/bln Full, $35/bln Dev) | 20/menit (seat Dev/Full) | 600 tool call/hari, 20/menit | **Ya**, lewat Variables REST API | Ya, penuh |

Poin paling menentukan, dan yang paling mudah salah dibaca: **di plan Starter
batas Tier 1 adalah 6 permintaan per bulan, bukan per menit**, dan berlaku
untuk semua tipe seat. `GET /v1/files`, `GET /v1/files/:key/nodes`, dan
`GET /v1/images` semuanya Tier 1. Satu kali menjalankan pipeline factory yang
menyentuh beberapa frame sudah menghabiskan kuota sebulan.

---

## 1. REST API: ketersediaan token dan batas rate per plan

### 1.1 Personal access token dan OAuth tersedia di semua plan

Dokumentasi personal access token tidak menyebut batasan plan sama sekali —
prosedurnya murni Settings → Security → Generate new token, dengan pilihan
expiration dan scope [VERIFIED-DOC:
https://developers.figma.com/docs/rest-api/personal-access-tokens/].
Halaman pricing mencantumkan baris "REST APIs — Tap into our REST APIs to
bring Figma into your external tools and products. Rate limits vary by seat,
plan, and API endpoint" dengan tanda centang di seluruh kolom plan
[VERIFIED-DOC: https://www.figma.com/pricing/].

**Jadi premis awal di tiket benar**: REST API di-gate oleh rate limit, bukan
oleh boleh/tidak boleh. Tapi lihat §1.2 — untuk Starter, rate limit-nya
sendiri sudah setara dengan larangan praktis.

Tiga jenis kredensial, dengan konsekuensi berbeda untuk CI:

| Kredensial | Tersedia di | Umur maksimum | Rate limit dihitung per |
|---|---|---|---|
| Personal access token | semua plan | **90 hari** | user, per plan |
| OAuth app | semua plan (perlu team/org sebagai owner) | token refresh | user, per plan, per app |
| **Plan access token** | **Organization dan Enterprise saja** | **365 hari** | token, per plan |

[VERIFIED-DOC: https://developers.figma.com/docs/rest-api/plan-access-tokens/
— "Plan access tokens are available for Organization and Enterprise plans",
"Max expiration of 1 year"; dan
https://developers.figma.com/docs/rest-api/rate-limits/ untuk basis
penghitungan]

Dokumen plan access token menyebut kelemahan dua opsi lain secara eksplisit
untuk kasus otomasi: personal access token "Tied to an individual user",
"Does not follow least privilege", "Max expiration of 90 days"; OAuth app
"Designed for interactive workflows, not automation", "Complex to set up for
internal automation use cases" [VERIFIED-DOC: URL yang sama].

**Implikasi operasional untuk factory** [INFERENSI]: di plan Starter atau
Professional, satu-satunya kredensial non-interaktif yang praktis adalah
personal access token milik satu orang, yang **wajib dirotasi tiap 90 hari**
dan membawa seluruh hak akses orang itu. Itu biaya perawatan yang nyata dan
melanggar least-privilege. Kredensial "service account" yang benar (plan
access token, dengan allowlist resource) baru ada di Organization ke atas.

### 1.2 Tabel rate limit — angka verbatim

Batas berlaku per menit kecuali ditulis lain. Kolom Starter memakai
`rowspan="2"`, artinya **satu nilai untuk kedua baris seat**.

**Tier 1** — `GET file`, `GET file nodes`, `GET image`:

| Seat | Starter | Professional | Organization | Enterprise |
|---|---|---|---|---|
| View, Collab | Up to 6/month | Up to 6/month | Up to 6/month | Up to 6/month |
| Dev, Full | *(sama: Up to 6/month)* | 10/min | 15/min | 20/min |

**Tier 2** — Comments, Dev Resources, Discovery, `GET image fills`, Folders,
Projects, `GET local variables`, `GET published variables`, Version History,
Webhooks:

| Seat | Starter | Professional | Organization | Enterprise |
|---|---|---|---|---|
| View, Collab | Up to 5/min | Up to 5/min | Up to 5/min | Up to 5/min |
| Dev, Full | *(sama: Up to 5/min)* | 25/min | 50/min | 100/min |

**Tier 3** — Activity Logs, Components & Styles, Developer Logs,
`GET file metadata`, Folder metadata, Library Analytics, Payments, Project
metadata, Users, `POST variables`:

| Seat | Starter | Professional | Organization | Enterprise |
|---|---|---|---|---|
| View, Collab | Up to 10/min | Up to 10/min | Up to 10/min | Up to 10/min |
| Dev, Full | *(sama: Up to 10/min)* | 50/min | 100/min | 150/min |

[VERIFIED-DOC: https://developers.figma.com/docs/rest-api/rate-limits/]

Prosa di halaman yang sama mengonfirmasi pembacaan kolom Starter, tanpa perlu
menafsirkan HTML: *"if you use a personal access token to get the content of
a file in a Starter plan, requests to that file are limited to up to 6 per
month even if you have a Full seat in a different plan"* [VERIFIED-DOC: URL
yang sama].

Dua peringatan tambahan yang penting:

- **Batas ditentukan oleh plan tempat file berada, bukan plan Anda.** "Rate
  limits are ... based on ... The location and plan of the resource that the
  user is requesting." Punya Full seat di Enterprise tidak menolong kalau
  file desainnya berada di draft/team Starter [VERIFIED-DOC].
- **Untuk View/Collab, angka tabel adalah plafon, bukan jaminan.** "Depending
  on traffic and demand, the actual limit may be lower. For example, a user
  with a View seat who tries to query a Tier 1 endpoint might only be able to
  make 2 requests in a month" [VERIFIED-DOC]. Karena kolom Starter memakai
  frasa "Up to" yang sama, [INFERENSI] kuota 6/bulan di Starter juga bisa
  jatuh lebih rendah saat trafik tinggi.

### 1.3 Perilaku saat kena limit

Figma memakai algoritma leaky bucket; saat bucket penuh, endpoint
mengembalikan **429** dengan field: `Retry-After` (integer, detik),
`X-Figma-Plan-Tier` (enum: `enterprise`, `org`, `pro`, `starter`, `student`),
`X-Figma-Rate-Limit-Type` (`low` untuk Collab/Viewer, `high` untuk
Full/Dev), dan `X-Figma-Upgrade-Link` [VERIFIED-DOC:
https://developers.figma.com/docs/rest-api/rate-limits/].

Saran resmi Figma untuk aplikasi yang kena limit — relevan langsung untuk
desain factory: batch permintaan (satu `GET /v1/images` dengan daftar node
id, bukan satu permintaan per gambar), **cache hasil**, dan hormati
`Retry-After` [VERIFIED-DOC: URL yang sama].

### 1.4 Rate limit ini baru, dan bisa berubah

Batas di atas berlaku sejak **17 November 2025**, bagian dari perubahan
platform developer yang juga mewajibkan seluruh OAuth app di-republish dengan
scope granular dan review Figma untuk app publik [VERIFIED-DOC:
https://developers.figma.com/docs/updates-to-figmas-developer-platform/].
Halaman rate limit mencantumkan peringatan eksplisit: "Figma reserves the
right to change rate limits. Changes may affect specific endpoints, tiers, or
plans" [VERIFIED-DOC]. Perlakukan angka ini sebagai benar per 2026-08-14,
bukan sebagai kontrak.

Catatan untuk OAuth: aplikasi wajib menunjuk **sebuah team atau organization
Figma sebagai pemilik app**; app yang hanya dipakai internal tidak perlu
review Figma, app publik perlu [VERIFIED-DOC: URL yang sama].

---

## 2. `GET /v1/files/:key` dan `GET /v1/images/:key`

### 2.1 Scope dan tier

| Endpoint | Tier | Scope |
|---|---|---|
| `GET /v1/files/:key` | Tier 1 | `file_content:read` |
| `GET /v1/files/:key/nodes` | Tier 1 | `file_content:read` |
| `GET /v1/images/:key` | Tier 1 | `file_content:read` |
| `GET /v1/files/:key/images` (image fills) | Tier 2 | `file_content:read` |
| `GET /v1/files/:key/meta` | Tier 3 | `file_metadata:read` |

[VERIFIED-DOC: https://developers.figma.com/docs/rest-api/file-endpoints/]

Ketiganya cukup dengan **satu scope**, `file_content:read` — "Read the
contents of files, such as nodes and the editor type", tanpa catatan
pembatasan plan [VERIFIED-DOC:
https://developers.figma.com/docs/rest-api/scopes/]. Scope lama `files:read`
sudah **deprecated** dan Figma menganjurkan pindah ke scope granular
[VERIFIED-DOC: URL yang sama].

### 2.2 `GET /v1/files/:key` — parameter yang menentukan biaya

Yang paling berguna untuk factory:

- `ids` — daftar node id dipisah koma. Hanya subset dokumen yang
  dikembalikan. **Peringatan resmi**: respons tetap bisa memuat node di luar
  rantai leluhur yang diminta, plus dependency subtree (mis. komponen lokal
  yang di-instance), dan **node canvas top-level selalu dikembalikan** —
  Figma menyebutnya "quirk" yang mungkin dihapus nanti.
- `depth` — integer positif. `depth=1` hanya Pages, `depth=2` Pages + objek
  top-level tiap page. Tanpa parameter ini, **seluruh node dikembalikan**.
- `geometry=paths` — untuk data vektor. Secara default vektor **tidak**
  dikembalikan.
- `version` — ambil versi tertentu, bukan versi terkini.

[VERIFIED-DOC: https://developers.figma.com/docs/rest-api/file-endpoints/]

`depth` dan `ids` adalah alat utama menahan ledakan ukuran respons
[INFERENSI]: tanpa keduanya, satu file desain berukuran wajar mengembalikan
pohon node lengkap sampai daun.

### 2.3 `GET /v1/images/:key` — umur URL, ukuran, dan sinkronitas

Fakta verbatim [VERIFIED-DOC:
https://developers.figma.com/docs/rest-api/file-endpoints/]:

- **Umur URL: "The image assets will expire after 30 days."** Angka 30 hari
  di tiket **terkonfirmasi**.
- **Ukuran maksimum: "Images up to 32 megapixels can be exported. Any images
  that are larger will be scaled down."** Ini batas megapiksel, bukan batas
  byte atau batas dimensi.
- Format: `jpg`, `png`, `svg`, `pdf`. `scale` antara 0.01 dan 4.
- Batch: satu permintaan bisa merender banyak node —
  `GET /v1/images/:key?ids=1:2,1:3,1:4`. Karena Tier 1 dihitung per
  permintaan, **membatch adalah cara langsung menurunkan konsumsi kuota**.
- Parameter SVG yang relevan untuk agent: `svg_include_id` (menaruh **nama
  layer** ke atribut `id` elemen SVG), `svg_include_node_id` (menaruh node id
  ke `data-node-id`), `svg_outline_text` (default `true` — teks jadi vector
  path; set `false` kalau ingin elemen `<text>` yang bisa dibaca).
- `use_absolute_bounds` — perlu untuk mengekspor node teks tanpa terpotong.
- Kegagalan render **tidak** membuat permintaan gagal: nilai `null` di map
  `images` menandakan node itu gagal dirender (node tak ada, invisible,
  opacity 0%, atau tanpa komponen renderable). Error 500 hanya untuk
  "Unexpected rendering error".

**Sinkron atau asinkron?** Dokumentasi menggambarkan satu permintaan yang
langsung mengembalikan `{ "err", "images", "status" }`, dengan "If no error
occurs, images will be populated with a map from node IDs to URLs of the
rendered images, and status will be omitted". **Tidak ada mekanisme polling,
job id, atau webhook penyelesaian yang didokumentasikan** [VERIFIED-DOC].
[INFERENSI] Perlakukan sebagai **sinkron**: satu permintaan HTTP yang
menunggu render selesai. Konsekuensinya, permintaan batch besar berpotensi
lama; Figma tidak mendokumentasikan timeout, jumlah maksimum node per
permintaan, atau SLA durasi render. Ini gap yang hanya bisa ditutup dengan
uji coba nyata (lihat §7).

Untuk gambar yang diunggah user (bukan hasil render), ada
`GET /v1/files/:key/images` — Tier 2, mengembalikan URL unduhan untuk semua
image fill, dan **URL-nya kedaluwarsa paling lama 14 hari** [VERIFIED-DOC].

**Konsekuensi arsitektur untuk factory** [INFERENSI]: karena URL render
kedaluwarsa 30 hari (dan URL image fill 14 hari), URL Figma **tidak boleh
disimpan sebagai referensi jangka panjang** di database atau di dokumen
desain. Factory harus mengunduh byte-nya dan menyimpannya sendiri. Ini
persis pola yang sudah dipilih jalur "commit ke repo + unggahan" — jadi
integrasi Figma hidup **tidak menghapus** kebutuhan blob store, ia hanya
mengganti sumber gambarnya.

---

## 3. Figma MCP server

### 3.1 Dua server yang berbeda, dua aturan akses yang berbeda

Ini sumber kebingungan yang paling umum, dan dua halaman resmi terlihat
bertentangan sampai dibaca berdampingan:

- **Remote MCP server** (`https://mcp.figma.com/mcp`, tanpa aplikasi
  desktop): *"The remote server is available on all seats and plans."*
- **Desktop/local MCP server** (butuh Figma desktop app): *"The desktop
  server is available on a Dev or Full seat for all paid plans."*

[VERIFIED-DOC:
https://help.figma.com/hc/en-us/articles/32132100833559-Guide-to-the-Figma-MCP-server]

**Jadi dugaan awal di tiket ("MCP menuntut seat berbayar") benar untuk server
desktop, dan salah untuk server remote.** Figma merekomendasikan yang remote:
"We recommend using the Remote MCP server ... The remote MCP server also
provides the broadest set of features" [VERIFIED-DOC:
https://developers.figma.com/docs/figma-mcp-server/].

### 3.2 Batas pemakaian MCP per plan

| Seat | Starter | Professional | Organization | Enterprise |
|---|---|---|---|---|
| View, Collab | Up to 20/month | Up to 6/month | Up to 6/month | Up to 6/month |
| Dev, Full | *(sama: Up to 20/month)* | 200/day, 10/min | 200/day, 15/min | 600/day, 20/min |

[VERIFIED-DOC:
https://developers.figma.com/docs/figma-mcp-server/rate-limits-access/]

Angka ini dikonfirmasi silang oleh matriks fitur di halaman pricing, yang
mencantumkannya per kolom plan tanpa perlu membaca `rowspan`: baris "Figma
MCP server — Let AI agents access Figma context to generate code and make
edits ... Rate limits vary by seat and plan" berisi **"20 tool calls /
month" | "200 tool calls / day and 10 calls / min" | "200 tool calls / day
and 15 calls / min" | "600 tool calls / day and 20 calls / min"**
[VERIFIED-DOC: https://www.figma.com/pricing/].

Prosa halaman rate limit MCP mengonfirmasi lagi: "If you're on a Starter plan
(20 tool calls per month), upgrade to a Pro, Organization, or Enterprise
plan" dan "If you have a Full or Dev seat on an Organization plan (200 tool
calls per day), upgrade to an Enterprise plan (600 tool calls per day)"
[VERIFIED-DOC].

Tool yang **menulis** ke Figma dikecualikan dari rate limit:
`add_code_connect_map`, `generate_figma_design`, `whoami` [VERIFIED-DOC].

Perbandingan langsung yang perlu diperhatikan: **di plan Starter, MCP server
(20 panggilan/bulan) memberi ~3x lebih banyak operasi daripada REST Tier 1
(6 permintaan/bulan)** [INFERENSI dari dua tabel di atas]. Keduanya tetap
jauh di bawah kebutuhan CI.

### 3.3 Apa yang MCP berikan dan REST tidak

Dari daftar tool resmi [VERIFIED-DOC:
https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/]:

1. **`get_design_context`** — menghasilkan **kode** dari sebuah layer/seleksi,
   default React + Tailwind, bisa diarahkan ke Vue, HTML+CSS, atau iOS lewat
   prompt. REST tidak punya padanan sama sekali; REST hanya memberi pohon
   node mentah.
2. **`get_variable_defs`** — "Returns the variables and styles used in your
   Figma selection (such as colors, spacing, typography)", termasuk **nama
   dan nilai**. Ini pembeda terbesar: lihat §4.3, lewat REST nama variable
   hanya terbaca di plan Enterprise.
3. **Integrasi Code Connect** (`get_code_connect_map`,
   `get_code_connect_suggestions`, `send_code_connect_mappings`) — memetakan
   node Figma ke komponen nyata di codebase, supaya kode yang dihasilkan
   memakai komponen yang sudah ada, bukan membuat baru.
4. **`get_metadata`** — representasi XML **sparse** berisi hanya id, nama,
   tipe, posisi, dan ukuran, dirancang sebagai outline murah untuk agent
   sebelum memanggil `get_design_context` pada bagian yang benar. REST tidak
   punya bentuk ringkas seperti ini; padanan terdekat adalah
   `GET /v1/files?depth=2`, yang tetap mengembalikan objek node penuh.
5. **Menulis ke kanvas** (`use_figma`, `generate_figma_design`,
   `create_new_file`, `upload_assets`, `generate_diagram`) — REST API tidak
   bisa membuat atau mengubah layer desain sama sekali.
6. **`search_design_system`** dan `get_libraries` (remote only) — mencari
   komponen/variable/style di seluruh library terhubung.
7. **`get_screenshot`** dan **`download_assets`** — padanan `GET /v1/images`,
   tapi `download_assets` menerima hingga 20 node per panggilan dan juga bisa
   mengembalikan **berkas sumber asli** (JPEG/PNG/GIF/WebP yang dipasang
   sebagai fill) tanpa render ulang. Tanpa export settings pada scale 1,
   render dibatasi ~4096px pada sisi terpanjang.

Panduan resmi Figma sendiri soal kapan memilih yang mana: *"If you are
building agentic software coordinated by models, the Figma MCP server will
save you time and give your users a better experience. If you need direct
access to specific APIs, use the REST API."* [VERIFIED-DOC:
https://developers.figma.com/docs/updates-to-figmas-developer-platform/]

### 3.4 Tiga penghalang MCP untuk factory headless

Ini bagian yang paling menentukan dan tidak tercermin di harga:

1. **Hanya klien yang terdaftar boleh menyambung.** "Only clients listed in
   the Figma MCP Catalog are able to connect to the Figma MCP Server. If
   you're a developer interested in connecting a new MCP client, you can join
   the waitlist" [VERIFIED-DOC:
   https://developers.figma.com/docs/figma-mcp-server/rate-limits-access/ dan
   https://developers.figma.com/docs/rest-api/scopes/]. Klien yang disebut:
   VS Code, Cursor, Claude Code, Codex, Xcode [VERIFIED-DOC:
   https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/].
   [INFERENSI] Sebuah worker factory buatan sendiri **tidak bisa** memanggil
   MCP server Figma langsung sebagai klien MCP generik — ia harus berjalan
   *di dalam* salah satu klien yang di-whitelist.
2. **Autentikasi interaktif per user.** "To use this server, you'll need to
   sign in through Figma's OAuth authentication flow", dan langkah
   pemasangannya secara literal adalah `/mcp` → Authenticate → **Click Allow
   Access** [VERIFIED-DOC: URL remote-server-installation di atas]. Tidak ada
   kredensial non-interaktif setara plan access token untuk MCP. Pengecualian
   satu-satunya: enterprise-managed authorization lewat **Okta Cross App
   Access, dan saat ini hanya untuk Claude** [VERIFIED-DOC:
   https://developers.figma.com/docs/figma-mcp-server/rate-limits-access/].
3. **Harganya belum final.** Figma menandai fitur ini berulang kali: "We're
   quickly improving how Figma supports AI agents. **This will eventually be
   a usage-based paid feature**, but is currently available for free during
   the beta period" [VERIFIED-DOC:
   https://developers.figma.com/docs/figma-mcp-server/]. [INFERENSI]
   Membangun jalur factory di atas MCP hari ini berarti membangun di atas
   harga yang Figma sudah umumkan akan berubah menjadi usage-based.

---

## 4. Bentuk data yang keluar dari `GET /v1/files`

Pertanyaan tiket: apakah nama layer, teks, ukuran, dan nama token benar-benar
terbaca, atau pohon node yang menuntut penafsiran berat?

**Jawaban singkat: tiga dari empat terbaca langsung dan mudah; nama variable
tidak.**

### 4.1 Struktur dasar

Setiap file adalah pohon: `DOCUMENT` di akar → `CANVAS` (satu per Page) →
node layer. Respons `GET /v1/files/:key` berbentuk:

```
{ name, role, lastModified, editorType, thumbnailUrl, version,
  document: Node, components: Map, componentSets: Map,
  schemaVersion, styles: Map, mainFileKey, branches: [...] }
```

[VERIFIED-DOC: https://developers.figma.com/docs/rest-api/file-endpoints/ dan
https://developers.figma.com/docs/rest-api/files/]

### 4.2 Yang terbaca langsung

**Nama layer — ya, sebagai properti global di setiap node.** Properti global
yang ada di *semua* node: `id`, **`name`** ("The name given to the node by the
user in the tool"), `visible`, `type`, `rotation`, `pluginData`,
`sharedPluginData`, `componentPropertyReferences`, **`boundVariables`**,
`explicitVariableModes` [VERIFIED-DOC:
https://developers.figma.com/docs/rest-api/files/].

**Isi teks — ya.** Node `TEXT` punya **`characters`** — "Text contained within
a text box" — sebagai string biasa. Juga tersedia `characterStyleOverrides`,
`lineTypes`, dan `lineIndentations` untuk gaya per-karakter dan struktur
daftar [VERIFIED-DOC:
https://developers.figma.com/docs/rest-api/file-node-types/].

**Ukuran dan posisi — ya.** `absoluteBoundingBox` ("Bounding box of the node
in absolute space coordinates") ada di praktis semua node yang terlihat, plus
`absoluteRenderBounds` (memperhitungkan drop shadow dan stroke tebal),
`minWidth`/`maxWidth`/`minHeight`/`maxHeight`, `constraints`, dan seluruh
properti auto-layout (`layoutMode`, `layoutAlign`, dst)
[VERIFIED-DOC: URL yang sama]. `size` dan `relativeTransform` hanya muncul
kalau `geometry=paths` dikirim.

**Nama style (Styles klasik) — ya.** Map `styles` di respons memetakan style
id ke metadata yang memuat **`name`**, `description`, `styleType` (`FILL`,
`TEXT`, `EFFECT`, `GRID`), `key`, dan `remote` [VERIFIED-DOC:
https://developers.figma.com/docs/rest-api/file-property-types/].

### 4.3 Yang TIDAK terbaca: nama variable/token

Node memuat `boundVariables`, tapi isinya hanya **`VariableAlias`**, yang
persis berisi dua field: `type: "VARIABLE_ALIAS"` dan **`id`** — "The id of
the variable that the current variable is aliased to. This variable can be a
local or remote variable, and both can be retrieved via the Variables
endpoints" [VERIFIED-DOC:
https://developers.figma.com/docs/rest-api/file-property-types/].

Artinya: untuk mengubah `VariableId:abc123` menjadi nama yang bermakna seperti
`color/surface/raised`, Anda **wajib** memanggil Variables REST API. Dan
Variables REST API dibatasi:

> "To use this API, you must have a **Full seat in an Enterprise org**;
> guests cannot use the API."
>
> | | GET | POST |
> |---|---|---|
> | Plan | Enterprise | Enterprise |
> | Account type | Any organization member | Full seats, admins |
> | File permissions | View access | Edit access |
> | Token scopes | `file_variables:read` | `file_variables:write` |

[VERIFIED-DOC: https://developers.figma.com/docs/rest-api/variables/]

Halaman scope mengonfirmasi dari sisi lain: `file_variables:read` — "Read
variables in files. **Note: Enterprise plan only**" [VERIFIED-DOC:
https://developers.figma.com/docs/rest-api/scopes/].

**Ini temuan paling tajam dari riset ini** [INFERENSI]: kalau tujuan
integrasi Figma hidup adalah menarik **nama design token** ke dalam factory,
jalur REST hanya berfungsi di **Enterprise**. Di Starter, Professional, dan
Organization, factory hanya mendapat ID variable buram yang tidak bisa
diresolusi. Satu-satunya jalan memutar adalah `get_variable_defs` di MCP
server — yang tersedia di semua plan tapi terkunci di klien yang
di-whitelist, autentikasi interaktif, dan harga beta yang akan berubah
(§3.4).

### 4.4 Berapa berat penafsirannya?

[INFERENSI, berdasarkan bentuk data terverifikasi di atas] Untuk agent,
usahanya bertingkat:

- **Ringan** — inventaris layar/komponen: iterasi pohon, baca `name`, `type`,
  `absoluteBoundingBox`. Cukup `GET /v1/files?depth=2` untuk daftar frame
  top-level per page.
- **Ringan** — ekstraksi seluruh copy/teks: kumpulkan `characters` dari semua
  node `TEXT`.
- **Sedang** — menurunkan spacing/layout: properti auto-layout ada dan
  bernama jelas, tapi harus disintesis dari banyak field
  (`layoutMode`, padding, `itemSpacing`, `constraints`) dan dari selisih
  bounding box.
- **Berat** — warna dan tipografi sebagai token: `fills` adalah array `Paint`
  dengan nilai RGBA mentah; kalau desainer memakai Variables, nama token-nya
  hilang di balik ID (§4.3). Nilai mentah bisa dibaca, tapi *nama*-nya —
  yang justru dibutuhkan agar kode yang dihasilkan memakai token dan bukan
  hex hardcoded — tidak.
- **Berat** — memetakan komponen Figma ke komponen React di repo. REST memberi
  `components`/`componentSets` beserta nama, tapi pemetaan ke kode adalah
  masalah tersendiri; itulah persis yang diselesaikan Code Connect, dan Code
  Connect hanya terpapar lewat MCP (§3.3).

Jadi: **bukan** pohon node buram yang tak terbaca — nama, teks, dan ukuran
memang langsung terpakai. Tapi lapisan yang paling bernilai untuk factory
(token bernama, pemetaan ke komponen kode) justru yang paling terkunci.

---

## 5. Harga plan

Harga per seat per bulan, USD, dibaca dari halaman pricing resmi
[VERIFIED-DOC: https://www.figma.com/pricing/]:

| | Full seat | Dev seat | Collab seat | Catatan penagihan |
|---|---|---|---|---|
| **Starter** | Gratis | — | — | "Free limited access to Figma products", unlimited drafts |
| **Professional** | $16/mo | $12/mo | $3/mo | Halaman punya toggle Monthly/Annual; angka ini yang tampil secara default |
| **Organization** | $55/mo | $25/mo | $5/mo | "Billed annually" |
| **Enterprise** | $90/mo | $35/mo | $5/mo | "Billed annually" |

Definisi seat yang relevan [VERIFIED-DOC: URL yang sama]:

- **Full seat**: akses penuh ke semua produk Figma termasuk Dev Mode.
- **Dev seat**: akses penuh ke **Dev Mode**, FigJam, Slides, Buzz; view +
  comment di file Figma Design. **Tidak bisa mengedit desain.**
- **Collab seat**: FigJam/Slides/Buzz; view + comment di Design; **hanya
  basic inspection di Dev Mode**.

Untuk rate limit REST dan MCP, **Dev seat dan Full seat diperlakukan
identik** — keduanya ada di baris tabel yang sama (§1.2, §3.2). [INFERENSI]
Untuk akun bot/CI yang hanya perlu *membaca*, **Dev seat sudah cukup dan
lebih murah**: $12 vs $16 di Professional, $25 vs $55 di Organization, $35 vs
$90 di Enterprise.

**Pengecualian, dan dokumentasi Figma bertentangan dengan dirinya sendiri di
sini.** Halaman Variables API menulis dalam prosa: "you must have a **Full
seat** in an Enterprise org". Tapi tabel persyaratan di halaman yang sama
persis di bawah kalimat itu menyebut untuk kolom **GET**: Account type =
"**Any organization member**", File permissions = "View access". Full seat
hanya tercantum tegas untuk kolom **POST** [VERIFIED-DOC — kedua pernyataan
di https://developers.figma.com/docs/rest-api/variables/, lihat kutipan di
§4.3]. Jadi apakah **membaca** variable menuntut Full seat atau cukup Dev
seat **tidak bisa dipastikan dari dokumentasi**. Untuk penganggaran: angka
aman **$90/bulan (Full seat)**, angka yang mungkin **$35/bulan (Dev seat)**.
Selisihnya $55/bulan, dan hanya bisa diselesaikan dengan satu kali percobaan
nyata di plan Enterprise.

**Peringatan** [INFERENSI]: harga Professional yang tampil kemungkinan besar
harga tagihan tahunan, karena kartunya punya toggle Monthly/Annual dan kartu
Organization/Enterprise ditandai eksplisit "Billed annually". Harga bulanan
Professional dirender di sisi klien dan tidak bisa saya baca dari HTML statis
— konfirmasikan langsung di halaman pricing sebelum menganggarkan.

---

## 6. Biaya sebenarnya untuk factory, per tier

Bukan hanya harga plan. Ini biaya total per jalur.

### Jika tim ada di Starter (gratis)

**Integrasi Figma hidup tidak bisa dijalankan.** Bukan mahal — tidak cukup.
6 permintaan Tier 1 **per bulan** (dan "actual limit may be lower") tidak
bisa menopang satu pipeline pun. MCP remote memberi 20 tool call/bulan, masih
jauh di bawah kebutuhan. Nama variable tidak terbaca. Biaya untuk mengambil
jalur ini = **biaya upgrade** (di bawah).

### Jika tim ada di Professional

- **Tambahan uang: $0** kalau seat yang ada sudah Dev/Full. Kalau perlu seat
  bot terpisah: **+$12/bulan** (Dev seat).
- REST Tier 1: 10/menit. Cukup untuk pipeline yang mem-batch dan cache.
- MCP: 200 tool call/hari, 10/menit.
- **Tetap tidak dapat**: nama variable/token lewat REST (Enterprise-only),
  dan plan access token (Org+). Kredensial CI harus personal access token
  milik seseorang, **rotasi tiap 90 hari**.
- Biaya rekayasa yang tetap harus dibayar: unduh dan simpan sendiri semua
  gambar (URL mati dalam 30 hari), lapisan cache, dan penanganan 429 dengan
  `Retry-After`.

### Jika tim ada di Organization

- **Tambahan uang: $0**, atau **+$25/bulan** untuk Dev seat bot.
- REST Tier 1: 15/menit. MCP: 200/hari, 15/menit.
- **Dapat tambahan yang penting**: plan access token — kredensial tanpa
  pemilik individual, masa berlaku sampai 365 hari, bisa dibatasi ke daftar
  resource tertentu. Ini menghapus masalah rotasi 90 hari dan
  least-privilege dari Professional.
- **Masih tidak dapat**: nama variable lewat REST.

### Jika tim ada di Enterprise

- **Tambahan uang: $0** kalau seat yang ada sudah memadai, atau **+$35/bulan**
  (Dev seat) untuk akun bot. **Kalau bot juga harus membaca nama variable,
  anggarkan +$90/bulan (Full seat)** — dokumentasi Figma bertentangan soal
  apakah *membaca* variable menuntut Full seat atau cukup anggota organisasi
  mana pun (lihat §5); $90 adalah angka aman, $35 angka yang mungkin.
- REST Tier 1: 20/menit. MCP: 600/hari, 20/menit.
- Semuanya terbuka: isi file, render gambar, plan access token, dan
  **`file_variables:read` untuk nama token**.

### Biaya yang sama di semua tier

[INFERENSI, berdasarkan fakta terverifikasi di §2.3] Bahkan di Enterprise,
integrasi Figma hidup **tidak menghapus** jalur gambar yang sekarang. URL
render mati dalam 30 hari dan URL image fill dalam 14 hari, jadi factory
tetap harus mengunduh dan menyimpan byte gambarnya sendiri. Integrasi Figma
mengganti **sumber** gambar, bukan kebutuhan menyimpannya.

### Rekomendasi

[INFERENSI] Keputusan bergantung pada apa yang sebenarnya diinginkan dari
Figma hidup:

1. **Kalau yang diinginkan nama design token** — jalur REST menuntut
   Enterprise + Full seat. Untuk tim kecil, itu tidak sebanding. Nyatakan
   jalur gambar (commit ke repo + unggahan) cukup, dan pindahkan token ke
   sumber kebenaran di repo, bukan di Figma.
2. **Kalau yang diinginkan inventaris layar, copy, dan ukuran** — Professional
   sudah cukup, dan seringkali tanpa biaya tambahan. Ini kandidat paling
   masuk akal untuk dicoba lebih dulu.
3. **Jangan bangun factory di atas MCP server Figma.** Bukan karena harga,
   tapi karena tiga penghalang di §3.4: hanya klien yang di-whitelist boleh
   menyambung, autentikasi interaktif per user, dan Figma sudah mengumumkan
   fitur ini akan menjadi usage-based paid. MCP cocok untuk developer di
   IDE-nya, bukan untuk worker headless.
4. **Kalau Starter** — keputusannya sudah dibuat oleh angkanya. Jalur gambar
   adalah satu-satunya pilihan sampai ada upgrade.

---

## 7. Yang tidak terverifikasi dan cara menutupnya

**Fakta yang harus dijawab user** (agent tidak bisa mencarinya): **plan Figma
tim sekarang, dan tipe seat orang yang akan menerbitkan token**. Cara cepat
memastikan tanpa menebak: panggil endpoint apa pun dengan personal access
token sampai kena 429, lalu baca header **`X-Figma-Plan-Tier`** — nilainya
salah satu dari `enterprise`, `org`, `pro`, `starter`, `student` — dan
**`X-Figma-Rate-Limit-Type`** (`low` = Collab/Viewer, `high` = Full/Dev)
[VERIFIED-DOC: https://developers.figma.com/docs/rest-api/rate-limits/].
Ingat §1.2: yang menentukan adalah plan tempat **file** berada, bukan plan
user.

Gap yang tersisa, semuanya butuh percobaan nyata, bukan dokumentasi:

1. **Perilaku waktu `GET /v1/images`.** Tidak ada timeout, jumlah maksimum
   node per permintaan, atau SLA durasi render yang didokumentasikan. Batch
   besar berpotensi lambat dan tidak ada jalur asinkron resmi.
2. **Ukuran nyata respons `GET /v1/files`** untuk file desain factory —
   bergantung sepenuhnya pada file, dan menentukan apakah `depth`/`ids` cukup
   untuk menahan konsumsi konteks agent.
3. **Harga bulanan (non-tahunan) Professional** — dirender di sisi klien,
   tidak terbaca dari HTML statis.
4. **Apakah membaca variable menuntut Full seat atau cukup Dev seat di
   Enterprise.** Prosa dan tabel di halaman Variables API resmi saling
   bertentangan (§5). Selisih anggaran $55/bulan per akun bot. Ditutup dengan
   satu permintaan `GET /v1/files/:key/variables/local` memakai token
   ber-scope `file_variables:read` dari akun Dev seat.
5. **Apakah plan Starter punya "team" yang bisa ditunjuk sebagai owner OAuth
   app.** Persyaratan owner berupa team/organization terverifikasi
   [VERIFIED-DOC:
   https://developers.figma.com/docs/updates-to-figmas-developer-platform/],
   tapi kelayakan Starter tidak disebut. Tidak menghalangi apa pun kalau
   memakai personal access token.

---

## Sumber

Semua dibaca 2026-08-14.

- Rate limits REST API —
  https://developers.figma.com/docs/rest-api/rate-limits/
- Personal access tokens —
  https://developers.figma.com/docs/rest-api/personal-access-tokens/
- Plan access tokens —
  https://developers.figma.com/docs/rest-api/plan-access-tokens/
- Scopes —
  https://developers.figma.com/docs/rest-api/scopes/
- File endpoints (`GET file`, `GET file nodes`, `GET image`,
  `GET image fills`, `GET file metadata`) —
  https://developers.figma.com/docs/rest-api/file-endpoints/
- Figma files / global properties —
  https://developers.figma.com/docs/rest-api/files/
- Node types —
  https://developers.figma.com/docs/rest-api/file-node-types/
- Property types (`VariableAlias`, `Style`) —
  https://developers.figma.com/docs/rest-api/file-property-types/
- Variables REST API (gating Enterprise) —
  https://developers.figma.com/docs/rest-api/variables/
- Updates to Figma's developer platform (rate limit 17 Nov 2025, review
  OAuth, REST vs MCP) —
  https://developers.figma.com/docs/updates-to-figmas-developer-platform/
- Figma MCP server — Introduction —
  https://developers.figma.com/docs/figma-mcp-server/
- Figma MCP server — Rate limits & access —
  https://developers.figma.com/docs/figma-mcp-server/rate-limits-access/
- Figma MCP server — Tools and prompts —
  https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/
- Figma MCP server — Remote server installation —
  https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/
- Guide to the Figma MCP server (remote vs desktop) —
  https://help.figma.com/hc/en-us/articles/32132100833559-Guide-to-the-Figma-MCP-server
- Plans & Pricing —
  https://www.figma.com/pricing/
