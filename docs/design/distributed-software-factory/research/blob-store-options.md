# Riset: Blob Store S3-Compatible untuk Self-Hosted CI/Orkestrasi

Status: **SELESAI** (riset primer via WebSearch + WebFetch + GitHub API pada
2026-08-01, tanpa instalasi langsung — lihat catatan verifikasi tiap klaim).

Konteks: sistem CI/orkestrasi self-hosted (docker-compose, Postgres,
TypeScript). Kebutuhan: API S3-compatible, presigned PUT untuk upload langsung
dari worker (file s.d. ~200MB), deployment single-node sederhana, backup
mudah (cukup backup direktori data/volume).

Tanda verifikasi: **[VERIFIED-DOC]** = dicek langsung ke dokumentasi
resmi/repo/GitHub API/halaman legal resmi. **[IMPRESSION]** = dari artikel
pihak ketiga, belum dicek penuh ke sumber primer.

**Catatan penting**: riset ini dilakukan 2026-08-01 dan menemukan perubahan
besar pada MinIO yang belum tentu tercermin di ringkasan/artikel lama —
`minio/minio` **sudah diarsipkan oleh pemiliknya per 25 April 2026** dan
Community Edition sudah tidak lagi menerima rilis binary baru. Lihat §1.3-1.4.

---

## Tabel perbandingan

| | Lisensi | Presigned PUT/GET | Presigned Multipart | Kompleksitas single-node | Kematangan |
|---|---|---|---|---|---|
| **MinIO (cabang AGPL, sekarang arsip)** | AGPL-3.0 [VERIFIED-DOC](https://github.com/minio/minio/blob/master/LICENSE), tapi repo **`minio/minio` diarsipkan 25 Apr 2026** dan tak lagi maintained [VERIFIED-DOC — dicek langsung via GitHub API & README] | Ya, `presignedPutObject`/`presignedGetObject` [VERIFIED-DOC] | Ya di level protokol (setiap `UploadPart`/`CreateMultipartUpload`/`CompleteMultipartUpload` bisa di-presign manual); SDK JS resmi **tak** punya helper siap pakai [VERIFIED-DOC: diskusi minio-js#772] | Sangat rendah — 1 binary/container | Sangat matang secara teknis, tapi CE sudah end-of-life de facto |
| **MinIO AIStor Free** (pengganti resmi CE) | **EULA proprietary, bukan open source** [VERIFIED-DOC: min.io/legal/aistor-free-agreement] | Ya (mewarisi server yang sama) | Ya | Sangat rendah — 1 binary, tapi **lisensi membatasi ke mode standalone/single-node saja** | Baru (2025-2026), aktif dikembangkan MinIO Inc, bukan lagi community project |
| **Garage** | AGPL-3.0 [VERIFIED-DOC: git.deuxfleurs.fr LICENSE] | Ya — "Implemented" di compat matrix resmi [VERIFIED-DOC] | Ya — ketujuh operasi MPU semua "Implemented" [VERIFIED-DOC] | Sangat rendah — 1 binary/container, `garage server --single-node --default-bucket`, 1 file TOML [VERIFIED-DOC] | Cukup matang untuk skala kecil: 30+ tag rilis (v0.9.0-beta1 → v2.3.0+), produksi di Deuxfleurs sendiri [VERIFIED-DOC: GitHub tags] |
| **SeaweedFS** | Apache-2.0 [VERIFIED-DOC: LICENSE file] | Ya — "Presigned URLs" tercantum didukung [VERIFIED-DOC] | Ya — seluruh siklus MPU didokumentasikan didukung [VERIFIED-DOC] | Rendah — 1 command `weed server -s3 -dir=...` menjalankan master+volume+filer+S3 gateway dalam 1 proses [VERIFIED-DOC] | Sangat matang — 33.8k+ GitHub star, commit harian |
| **Zenko CloudServer** | Apache-2.0 [VERIFIED-DOC: GitHub API] | Ya (dipakai luas; bug report soal presigned+metadata justru membuktikan fiturnya ada) [VERIFIED-DOC: scality/cloudserver#4281] | Ya — Initiate/Abort/Complete MPU, UploadPart, UploadPartCopy, ListMultipartUploads, ListParts semua didokumentasikan [VERIFIED-DOC: ARTESCA docs] | Sedang — 1 container, tapi harus pilih backend (file/in-memory/multi-backend), 2 port tambahan (9990/9991) internal [VERIFIED-DOC] | Matang sbg dev/test tool; repo aktif (`pushed_at` 2026-07-31) tapi diposisikan resmi sbg alat CI-testing, bukan storage produksi jangka panjang |
| **Ceph RGW** | LGPL-2.1 (RGW spesifik) + campuran lisensi lain per-file [VERIFIED-DOC: ceph/COPYING] | Ya, cakupan S3 API terluas di antara semua opsi | Ya | **Tinggi** — didesain untuk cluster (mon+mgr+osd); image demo single-container ada tapi eksplisit ditujukan demo/dev, bukan produksi [VERIFIED-DOC: docs.ceph.com/cephadm/services/rgw] | Sangat matang, implementasi S3 API paling lengkap di luar AWS sendiri |
| **rclone serve s3** | MIT [VERIFIED-DOC: GitHub API] | PUT/GET dasar jalan, tapi presigned query-auth dilaporkan gagal 403 di issue resmi, status perbaikan tak jelas dari dok command saat ini [VERIFIED-DOC: rclone/rclone#7616] | **Tidak andal utk resume**: part harus berurutan (1,2,3,...), semua part di-buffer di memori (default 256M), server-side-copy MPU dilaporkan rusak utk file besar [VERIFIED-DOC: rclone.org/commands/rclone_serve_s3] | Sangat rendah — 1 binary | Dokumentasi resmi eksplisit menandai **"Experimental"** — "use with care" [VERIFIED-DOC] |
| **s3rver (Node/TS in-process)** | MIT [VERIFIED-DOC] | Ya untuk kasus dasar (dirancang utk testing) | Tidak dirancang/didokumentasikan utk resume MPU produksi | Sangat rendah — library in-process | **Tidak terawat**: repo `jamhall/s3rver` diarsipkan di GitHub, rilis npm terakhir 3.7.1 tahun 2021, 58 issue terbuka [VERIFIED-DOC: GitHub API + npm registry] |

---

## 1. MinIO — lisensi & perubahan 2024-2025

### 1.1 Lisensi
`minio/minio` berlisensi **GNU AGPLv3** sejak transisi penuh di rilis
`RELEASE.2021-05-11T23-27-41Z` — server, client, dan gateway ikut AGPLv3; SDK
client tetap Apache-2.0, dokumentasi CC BY-SA 4.0.
**[VERIFIED-DOC]** [min.io blog — From Open Source to Free and Open Source](https://www.min.io/blog/from-open-source-to-free-and-open-source-minio-is-now-fully-licensed-under-gnu-agplv3),
[minio/minio LICENSE](https://github.com/minio/minio/blob/master/LICENSE) (dicek
langsung: header "GNU AFFERO GENERAL PUBLIC LICENSE, Version 3").

### 1.2 Penghapusan Console dari Community Edition (2025)
26 Februari 2025, co-founder MinIO **Harshavardhana** mengganti console admin
penuh dengan "AGPL Object Browser" yang jauh lebih sederhana — menghapus
sekitar 100.000 baris kode console (user/policy management, bucket policy UI,
lifecycle & tiers management, site replication UI) dari Community Edition,
menyisakan object browser dasar saja.
**[VERIFIED-DOC]** Diskusi resmi GitHub: [minio/minio#21320](https://github.com/minio/minio/issues/21320)
— dicek langsung, thread berisi balasan maintainer.

Kutipan langsung Harshavardhana dari thread tsb: *"A whole team is involved in
console development alone, including design, UX, front-end, back-end, and pen
testing."* dan *"Admin actions in the console lack corresponding security
protections. Without dedicated maintenance, this code risks introducing
security vulnerabilities."* Saat ditanya apakah console akan dikembalikan:
*"No, there are no plans to bring it back until there are serious efforts from
the community that address our concerns about long-term maintainability."*
**[VERIFIED-DOC]** [minio/minio#21320](https://github.com/minio/minio/issues/21320).

Manajemen tetap bisa lewat CLI `mc`, hanya UI web yang dipangkas.
**[VERIFIED-DOC]** [Blocks & Files — MinIO users complain after admin UI removed from Community Edition](https://www.blocksandfiles.com/ai-ml/2025/06/19/minio-users-complain-after-admin-ui-removed-from-community-edition/1610856)
(laporan pihak ketiga, tapi mengutip commit/PR & diskusi GitHub resmi yang
sudah diverifikasi silang di atas).

### 1.3 Repo diarsipkan (April 2026)
Dicek **langsung** via GitHub API pada 2026-08-01: `minio/minio` berstatus
`"archived": true`, `pushed_at: 2026-04-24`.
**[VERIFIED-DOC]** `gh api repos/minio/minio` — dicek langsung sesi ini.

README repo saat ini menampilkan banner GitHub: *"This repository was
archived by the owner on Apr 25, 2026. It is now read-only."* dan pernyataan
tegas: *"THIS REPOSITORY IS NO LONGER MAINTAINED."* README mengarahkan ke dua
alternatif resmi: **AIStor Free** (edisi standalone gratis) dan **AIStor
Enterprise** (edisi terdistribusi berbayar). README juga menyatakan MinIO
"no longer provide pre-compiled binary releases for the community version" —
instalasi CE sekarang **source-only**.
**[VERIFIED-DOC]** Dicek langsung ke github.com/minio/minio (WebFetch,
2026-08-01).

### 1.4 AIStor Free — pengganti resmi, tapi bukan lagi AGPL
MinIO AIStor Free diatur oleh **EULA proprietary** ("MinIO AIStor Free Tier
License Agreement"), **bukan** lisensi open source. Izin yang diberikan:
*"limited, non-exclusive, non-transferable, royalty-free license to install
and use the Software solely in standalone mode (single-node deployments
without distributed clustering or high availability)"* — mengizinkan
pemakaian produksi komersial, prototyping, homelab, riset, backup, dsb,
**selama tidak butuh mode terdistribusi**.

Larangan eksplisit: *"You may not modify, reverse engineer, decompile,
disassemble, or create derivative works"* dan *"You may not distribute,
sublicense, rent, lease, resell, or redistribute the Software."*
**[VERIFIED-DOC]** [min.io/legal/aistor-free-agreement](https://www.min.io/legal/aistor-free-agreement)
— dicek langsung.

Implikasi: restriksi "standalone/single-node only" ini kebetulan **cocok**
dengan kebutuhan kita, tapi ini bukan lagi lisensi copyleft AGPL yang bisa
kita modifikasi/fork/redistribusikan — murni EULA sumber-tertutup-secara-legal.

### 1.5 Fork komunitas
Sebagai respons, komunitas membuat fork **OpenMaxIO** yang mempertahankan
console lama secara open, termasuk `openmaxio-object-browser` (fork dari
console lama MinIO, bukan afiliasi resmi MinIO Inc).
**[VERIFIED-DOC]** [github.com/OpenMaxIO/openmaxio-object-browser](https://github.com/OpenMaxIO/openmaxio-object-browser)
— README: *"This is a community driven project and is not affiliated with
MinIO, Inc."*

### 1.6 Kesimpulan viabilitas MinIO untuk kasus kita
Perubahan console (§1.2) sendiri **tidak menyentuh S3 data-plane** — presigned
PUT/GET dan multipart upload lewat API S3 standar tetap berfungsi penuh, cuma
GUI admin yang hilang (bisa digantikan CLI `mc`). Kalau cuma soal itu, MinIO
masih layak.

Tapi temuan yang lebih besar (§1.3-1.4) mengubah gambaran: repo utama sekarang
**arsip/read-only** → tidak ada lagi security patch resmi ke depan untuk
cabang AGPL/CE. Rute maju resmi MinIO adalah AIStor Free (EULA proprietary,
tanpa hak modifikasi/redistribusi) atau AIStor Enterprise (mulai ~$96.000/tahun
**[IMPRESSION]**, dari [Futuriom](https://www.futuriom.com/articles/news/minio-faces-fallout-for-stripping-features-from-web-gui/2025/06),
belum dicek ke price sheet resmi).

Untuk sistem CI internal kita: MinIO **masih fungsional** (presigned PUT/GET +
MPU penuh), tapi punya risiko jangka panjang nyata — tanpa patch resmi di
jalur AGPL, dan AIStor Free membatasi hak legal kita (tak boleh fork/modifikasi)
meski gratis untuk single-node. Ini keputusan yang butuh exit-plan eksplisit
kalau tetap dipilih.

---

## 2. Alternatif single-binary/single-container

### 2.1 Garage (Deuxfleurs)
Lisensi **AGPL-3.0** penuh, dicek langsung ke
`git.deuxfleurs.fr/Deuxfleurs/garage/raw/branch/main/LICENSE` (header "GNU
AFFERO GENERAL PUBLIC LICENSE, Version 3").
**[VERIFIED-DOC]**

Compat matrix resmi menandai **Presigned URLs: Implemented** dan seluruh 7
operasi multipart upload (`CreateMultipartUpload`, `UploadPart`,
`UploadPartCopy`, `CompleteMultipartUpload`, `AbortMultipartUpload`,
`ListMultipartUpload`, `ListParts`) sbg **Implemented**.
**[VERIFIED-DOC]** [garagehq.deuxfleurs.fr — S3 Compatibility status](https://garagehq.deuxfleurs.fr/documentation/reference-manual/s3-compatibility/)

Deploy single-node: 1 command `garage server --single-node --default-bucket`,
1 file `garage.toml`, tanpa dependency database/message-broker eksternal —
cocok untuk docker-compose (`dxflrs/garage:v2.3.0`).
**[VERIFIED-DOC]** [garagehq.deuxfleurs.fr — Quick Start](https://garagehq.deuxfleurs.fr/documentation/quick-start/)

Maturitas: 30+ tag rilis dari v0.9.0-beta1 sampai v2.3.0+ (dicek langsung via
GitHub API tags), dipakai produksi oleh Deuxfleurs (operator hosting
non-profit yang membuatnya) sejak sebelum stabilisasi versi 1.0.
**[VERIFIED-DOC]** GitHub tags `deuxfleurs-org/garage` — dicek langsung.

Catatan desain: Garage secara eksplisit ditargetkan untuk *"small self-hosted
geo-distributed deployments"* — kekuatannya justru di skenario
multi-node/multi-region tak-simetris; untuk single-node murni ia tetap jalan
penuh tapi kita tidak memanfaatkan diferensiatornya.
**[IMPRESSION]** dari deskripsi repo `deuxfleurs-org/garage`.

### 2.2 SeaweedFS
Lisensi **Apache-2.0**, dicek langsung ke `LICENSE` file di repo.
**[VERIFIED-DOC]**

Wiki S3 API resmi menandai **Presigned URLs** dan seluruh siklus multipart
upload (CreateMultipartUpload/UploadPart/UploadPartCopy/CompleteMultipartUpload/AbortMultipartUpload/ListMultipartUploads/ListParts)
sbg didukung; "All multipart operations are implicitly allowed when
`s3:PutObject` is granted."
**[VERIFIED-DOC]** [github.com/seaweedfs/seaweedfs/wiki/Amazon-S3-API](https://github.com/seaweedfs/seaweedfs/wiki/Amazon-S3-API)

Deploy single-node: 1 command `weed server -dir=/data -s3` menjalankan
master+volume+filer+S3 gateway dalam **satu proses/satu container**. Ada juga
`weed mini` yang menjalankan komponen serupa (termasuk WebDAV & Admin UI)
dalam 1 proses.
**[VERIFIED-DOC]** [github.com/seaweedfs/seaweedfs/wiki/Getting-Started](https://github.com/seaweedfs/seaweedfs/wiki/Getting-Started)

Catatan bug kecil: presigned PUT dengan Content-MD5 salah mengembalikan 500
alih-alih 400 BadDigest standar AWS — bug kosmetik penanganan-error, bukan
soal dukungan fitur.
**[VERIFIED-DOC]** [seaweedfs#7305](https://github.com/seaweedfs/seaweedfs/issues/7305)

Maturitas: 33.8k+ star GitHub, `pushed_at` = hari riset ini dilakukan →
pengembangan sangat aktif, dipakai luas sbg drop-in MinIO alternative.
**[VERIFIED-DOC]** `gh api repos/seaweedfs/seaweedfs`.

### 2.3 Zenko CloudServer (scality/cloudserver)
Lisensi **Apache-2.0**.
**[VERIFIED-DOC]** `gh api repos/scality/cloudserver`.

Multipart upload didokumentasikan lengkap: Initiate/Abort/Complete MPU,
UploadPart, UploadPartCopy, ListMultipartUploads, ListParts.
**[VERIFIED-DOC]** ARTESCA docs (dokumentasi S3 resmi Scality yang menaungi
CloudServer): [downloads.scality.com/artesca-ova/doc/reference/s3](https://downloads.scality.com/artesca-ova/doc/reference/s3/index.html)

Dukungan presigned URL tak dinyatakan eksplisit di README, tapi ada bug
report resmi soal metadata pada presigned link yang justru membuktikan fitur
presigned dipakai & berfungsi di level dasar (masalahnya spesifik soal
metadata custom, bukan soal presigned itu sendiri tidak jalan).
**[VERIFIED-DOC]** [scality/cloudserver#4281](https://github.com/scality/cloudserver/issues/4281)

Deploy: 1 image Docker (`zenko/cloudserver`), tapi mengharuskan memilih
backend data (file/in-memory/multi-backend/cloud), dan membuka 2 port
tambahan (9990/9991) untuk transfer metadata/data internal — sedikit lebih
kompleks dari Garage/SeaweedFS yang benar-benar "satu port, selesai."
**[VERIFIED-DOC]** README `scality/cloudserver`.

Positioning resmi proyek: *"useful for Developers, either to run as part of a
continuous integration test environment to emulate the AWS S3 service
locally or as an abstraction layer..."* — didokumentasikan lebih sbg alat
dev/CI-testing daripada storage produksi jangka panjang, meski repo-nya
sendiri aktif dan dipelihara Scality (`pushed_at` 2026-07-31).
**[VERIFIED-DOC]** README + `gh api repos/scality/cloudserver`.

### 2.4 Ceph RGW
Lisensi: RGW (RADOS Gateway) khususnya **LGPL-2.1-only**; monorepo Ceph
secara keseluruhan campuran LGPL 2.1/3.0 + sebagian BSD/public domain,
rincian per-file ada di `COPYING`.
**[VERIFIED-DOC]** [github.com/ceph/ceph/blob/main/COPYING](https://github.com/ceph/ceph/blob/main/COPYING),
[COPYING-LGPL2.1](https://github.com/ceph/ceph/blob/main/COPYING-LGPL2.1)

Kompleksitas single-node: Ceph secara desain adalah cluster software —
deployment resmi via `cephadm`/`ceph orch apply rgw` mengasumsikan cluster
mon/mgr/osd sudah berjalan; dokumentasi resmi RGW service tidak menyediakan
jalur "1 container saja" untuk produksi. Ada image demo (`ceph/demo`) yang
menjalankan semua daemon (mon, mgr, osd, mds, rgw) dalam satu container untuk
pembelajaran, tapi bukan topologi yang direkomendasikan untuk beban kerja
nyata.
**[VERIFIED-DOC]** [docs.ceph.com/en/latest/cephadm/services/rgw](https://docs.ceph.com/en/latest/cephadm/services/rgw/)

Untuk requirement kita (single-node, docker-compose sederhana), Ceph RGW
jelas **overkill** dari sisi operasional dibanding Garage/SeaweedFS — pilihan
tepat kalau memang butuh cluster storage terdistribusi skala besar, bukan
untuk 1 node CI internal.

Maturitas & cakupan API: tertua dan paling matang dari semua opsi di sini,
cakupan S3 API-nya paling luas (mendekati kelengkapan AWS S3 sendiri) — tapi
tidak relevan sbg keunggulan kalau biaya operasionalnya tak sepadan skala
kita.

### 2.5 rclone serve s3
Lisensi **MIT**.
**[VERIFIED-DOC]** `gh api repos/rclone/rclone`.

Dokumentasi resmi menyebut command ini secara eksplisit: *"`serve s3` is
considered **Experimental** so use with care."*
**[VERIFIED-DOC]** [rclone.org/commands/rclone_serve_s3](https://rclone.org/commands/rclone_serve_s3/)

Presigned URL: ada issue resmi terbuka, user melaporkan *"Using the S3 API
you can generate a pre-signed URL just fine, but when it comes to actually
using that pre-signed url, it fails with 403 Not Authorized Errors."* Status
pastinya campur aduk — issue tercatat closed dengan PR terkait di dependency
`rclone/gofakes3`, tapi dokumentasi command resmi saat ini tidak menyebutkan
dukungan presigned sama sekali, jadi statusnya **tidak bisa dipastikan andal**
dari sumber primer.
**[VERIFIED-DOC]** [rclone/rclone#7616](https://github.com/rclone/rclone/issues/7616)
— isi thread lengkap tidak sepenuhnya termuat saat fetch, rekomendasi:
verifikasi manual sebelum dipakai.

Multipart: dokumentasi resmi menyatakan part harus datang berurutan
(`1,2,3,...`) dan semua part di-buffer di memori
(`--multipart-streaming-buffer-limit`, default 256M) — desain ini **tidak
cocok** untuk skenario "presigned multipart yang bisa di-resume dari titik
gagal" karena part yang datang out-of-order (mis. retry part ke-3 setelah
part ke-5 sempat terkirim) berpotensi tidak didukung dengan baik.
Server-side-copy MPU juga dilaporkan rusak untuk file besar.
**[VERIFIED-DOC]** [rclone.org/commands/rclone_serve_s3](https://rclone.org/commands/rclone_serve_s3/)

Kesimpulan: cocok untuk kebutuhan ringan/dev (misal expose storage backend
rclone lain sbg S3), **tidak direkomendasikan** untuk kebutuhan
presigned-multipart-resume produksi kita.

---

## 3. Library server Node/TypeScript in-process

**s3rver** (`jamhall/s3rver`) adalah satu-satunya kandidat nyata yang
ditemukan untuk "S3 server yang jalan in-process di Node/TS" (bukan sekadar
client — `minio-js` dan `aws-sdk`/`@aws-sdk/client-s3` adalah **client**,
bukan server, jadi tidak relevan menjawab pertanyaan ini).
**[VERIFIED-DOC]** npm listing `s3rver`: *"A fake S3 server written in
NodeJs"*, tujuan eksplisit sbg dev/testing tool: *"minimise runtime
dependencies and be more of a development tool to test S3 calls in your code
rather than a production server."*

Status maintenance, dicek langsung:
- GitHub API: `"archived": true`, `open_issues_count: 58`,
  `pushed_at: 2025-08-10` (commit terakhir sebelum diarsipkan).
- npm registry: versi terakhir **3.7.1**, dipublikasikan **2021-10-03**;
  `time.modified` (perubahan metadata terakhir) 2022-06-26 — **tidak ada
  rilis baru selama ~5 tahun**.

**[VERIFIED-DOC]** `gh api repos/jamhall/s3rver` +
`registry.npmjs.org/s3rver` — dicek langsung sesi ini.

Ada beberapa fork/scoped-package turunan (`@20minutes/s3rver`,
`@makerstudios/s3rver`) tapi semuanya juga tidak aktif secara signifikan atau
lebih tua lagi.
**[IMPRESSION]** dari hasil pencarian npm, belum dicek satu-satu ke registry.

Kesimpulan: **s3rver eksplisit ditujukan untuk testing**, bukan storage
produksi (tidak dirancang untuk resume MPU yang gagal di tengah jalan, tidak
ada jaminan durability data), dan sekarang **tidak terawat sama sekali**
(archived + 5 tahun tanpa rilis). Tidak layak jadi storage layer produksi
untuk sistem CI ini — paling banter dipakai di test suite internal.

---

## 4. Presigned multipart upload — siapa yang benar-benar mendukungnya

Presigned multipart upload bukan "fitur khusus" yang harus diimplementasikan
terpisah oleh server — secara protokol S3, ia hanyalah menerapkan **SigV4
query-string authentication** yang sama ke setiap request individual
(`CreateMultipartUpload`, `UploadPart` per bagian, `CompleteMultipartUpload`).
Jadi selama server (a) mengimplementasikan penuh operasi MPU AWS S3, dan (b)
mendukung SigV4 presigned/query-auth di semua endpoint (bukan cuma
`GetObject`/`PutObject` biasa), maka presigned-multipart-resume otomatis bisa
dilakukan client-side dengan menyusun URL presigned per bagian.
**[VERIFIED-DOC]** [AWS S3 API — UploadPart](https://docs.aws.amazon.com/AmazonS3/latest/API/API_UploadPart.html):
endpoint `UploadPart` memakai skema `Authorization`/SigV4 standar yang sama
seperti operasi S3 lainnya, tidak ada mekanisme auth berbeda utk MPU.

Berdasar cross-check di atas:

| Server | MPU penuh (Create/UploadPart/Complete) | SigV4 presigned di semua endpoint | Presigned-multipart-resume layak dipakai? |
|---|---|---|---|
| MinIO (AGPL/AIStor Free) | Ya | Ya | **Ya**, tapi manual (SDK JS resmi tak punya helper — lihat [minio-js#772](https://github.com/minio/minio-js/issues/772); harus generate presigned URL per part sendiri, mis. pakai `@aws-sdk/client-s3` yg lebih fleksibel dp `minio-js`) |
| Garage | Ya (7/7 operasi "Implemented") | Ya ("Implemented") | **Ya**, resmi didokumentasikan di compat matrix |
| SeaweedFS | Ya (siklus lengkap didokumentasikan) | Ya | **Ya** |
| Zenko CloudServer | Ya (didokumentasikan lengkap di ARTESCA docs) | Presigned dipakai & berfungsi (bug report soal metadata membuktikan ini), tapi tak ada pernyataan eksplisit cakupan presigned di semua endpoint MPU | **Kemungkinan besar ya**, belum ada bukti primer eksplisit spesifik utk presigned-UploadPart |
| Ceph RGW | Ya, implementasi S3 API paling lengkap | Ya | **Ya** |
| rclone serve s3 | Terbatas — part harus sekuensial, semua di-buffer di memori | Tidak stabil (403 dilaporkan) | **Tidak direkomendasikan** — desain sekuensial-in-memory berlawanan dgn tujuan "resume upload yang gagal di tengah" |
| s3rver | Tidak dirancang utk ini, tool testing | — | **Tidak relevan**, bukan untuk produksi |

---

## Rekomendasi

Untuk kebutuhan kita — **single-node self-hosted, docker-compose, presigned
PUT sampai ~200MB, backup = backup direktori data** — 200MB sebenarnya **di
bawah** batas presigned-PUT-tunggal S3 standar manapun (S3 mengizinkan single
PUT sampai 5GB), jadi multipart mungkin bahkan tidak wajib dipakai untuk
kasus ini kecuali ingin resume granular per-chunk; tapi kalau memang mau
desain tahan-gagal, semua kandidat di baris "Ya" pada tabel §4 memenuhi.

Kandidat realistis, diurutkan:

1. **Garage** — AGPL-3.0 murni (bukan EULA proprietary spt MinIO sekarang),
   compat matrix resmi mengonfirmasi presigned + MPU penuh, deployment paling
   ringan dari semua opsi (1 command, 1 file TOML, `--single-node`), dan
   proyeknya justru dirancang untuk skenario kecil/self-hosted seperti kita
   — walau kekuatan intinya (geo-distribusi) tak kepakai.
2. **SeaweedFS** — Apache-2.0 (lebih permisif dari AGPL kalau itu jadi
   concern), presigned+MPU penuh terdokumentasi, dev sangat aktif (33.8k
   star), sedikit lebih "berat" konsepnya (master/volume/filer digabung
   dalam 1 command) tapi tetap 1 container.
3. **MinIO (AGPL, versi arsip)** — masih fungsional penuh hari ini, tapi
   punya risiko strategis: repo utama sudah diarsipkan, tidak ada patch
   resmi ke depan di jalur AGPL, dan rute maju resmi (AIStor Free) adalah
   EULA proprietary yang melarang modifikasi/redistribusi walau gratis
   untuk single-node. Kalau dipakai, sadari ini keputusan yang butuh
   exit-plan.

**Tidak direkomendasikan** untuk kasus kita: Ceph RGW (kompleksitas
operasional jauh melebihi kebutuhan 1-node), rclone serve s3 (eksplisit
experimental + masalah presigned/MPU terdokumentasi resmi), Zenko CloudServer
(diposisikan resmi sbg dev/CI-testing tool, bukan storage produksi jangka
panjang, meski secara teknis mungkin jalan), dan s3rver (arsip, 5 tahun tanpa
rilis, murni testing tool).

Gap yang belum terverifikasi penuh: dukungan presigned-URL Zenko CloudServer
di level endpoint MPU spesifik (baru terbukti tidak-langsung lewat bug
report), dan detail resolusi final issue presigned di rclone `serve s3`
(thread GitHub tidak termuat penuh saat fetch — perlu dibaca manual sebelum
keputusan final kalau rclone jadi kandidat serius).
