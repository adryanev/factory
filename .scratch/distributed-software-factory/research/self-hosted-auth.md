# Riset: Opsi Auth Self-Hosted untuk Distributed Software Factory

Status: **selesai** (riset primer via web search + WebFetch + GitHub API, tanpa
instalasi langsung — lihat catatan verifikasi tiap klaim).

Konteks: orkestrator AI coding agent internal, satu tim, **harus self-host
penuh** (tanpa layanan pihak ketiga berbayar). Stack: pnpm monorepo
TypeScript — control plane (Hono/Fastify), runner CLI, web React + Vite,
Postgres.

Kosakata terkunci:
- **Principal** = identitas yang memicu Run & memegang credential. Dua jenis:
  **User** (manusia) dan **ServiceAccount** (non-manusia, milik satu Project).
- **Project** = unit isolasi. Anggota, peran, credential, secret,
  ServiceAccount, Pipeline, Repository menempel di sini. Batas keamanan
  berhenti di sini.
- **Runner** = mesin terdaftar, join token sekali pakai, koneksi
  outbound-only di belakang NAT. **Bukan Principal** — identitas mesin
  terpisah.

Tanda verifikasi: **[terverifikasi: sumber]** = dicek langsung ke dokumentasi
resmi / repo / GitHub API. **[kesan]** = ringkasan dari artikel pihak ketiga
atau pengetahuan umum, belum dicek ke sumber primer — jangan dianggap fakta
keras.

---

## Tabel perbandingan

| | Beban self-host | Model org/Project | Integrasi Hono/Fastify+SPA | ServiceAccount | Runner (join-token) | SSO nanti | Lisensi | RBAC di free tier? | Audit bawaan |
|---|---|---|---|---|---|---|---|---|---|
| **better-auth** | Library, 0 container tambahan, pakai Postgres sendiri | Organization plugin: org→member→role (custom role via access control) | Native, cookie session atau JWT+JWKS opsional | API key plugin, bisa org-owned, permissions+expiry — tapi bukan tipe principal khusus | Tidak ada konsep bawaan | Plugin SSO (OIDC+SAML sbg SP) | MIT | Ya, gratis | **Tidak** — fitur resmi butuh layanan hosted "Better Auth Infrastructure" |
| **Lucia** | N/A | N/A | N/A | N/A | N/A | N/A | MIT tapi **mati** (deprecated Mar 2025) | — | — |
| **Ory Kratos** | Kratos = identitas saja. Untuk OAuth2/M2M butuh **+Hydra** (2 servis) | Tidak ada Organization di OSS; B2B org = **OEL berbayar** | Standar OIDC bila dipasangkan Hydra | Via Hydra client-credentials — servis terpisah dari identitas Kratos | Tidak ada konsep bawaan | OIDC login sudah OSS; org-level SSO = OEL | Apache 2.0 core / **OEL berbayar untuk org, SAML, SCIM** | Ya (tanpa org) | Log biasa, tak ada UI audit khusus [kesan] |
| **Keycloak** | 1 container JVM + Postgres sendiri | **Organizations (GA sejak v26)** + Realm/Client Roles — gratis penuh | Standar OIDC/OAuth2, tanpa SDK proprietary | Service Account per Client, role langsung ke situ | Tidak ada konsep bawaan | IdP/broker penuh, ini keahlian intinya | Apache 2.0 | **Ya, gratis, termasuk Organizations** | Login Events + Admin Events bawaan, listener SPI |
| **Authentik** | docker-compose: server+worker+Postgres+Redis, ~600MB idle [kesan, blog pihak ke-3] | Groups + object-level permission; "Tenants" = install terpisah, bukan per-Project | Standar OIDC/SAML | Service account/API token untuk API Authentik sendiri; M2M app butuh OAuth2 Provider terpisah | Tidak ada konsep bawaan | IdP/broker penuh | MIT core / enterprise dir proprietary | Ya, RBAC dasar gratis; RBAC lanjutan = enterprise | **Ya**, unified Event system bawaan |
| **Zitadel** | 1 binary Go + Postgres saja (tanpa Redis, CockroachDB sudah di-drop) | **Organization→Project→Role→Grant**, cocok nyaris 1:1 ke Project kami | Standar OIDC/OAuth2/SAML | **Service Accounts** first-class: JWT profile, client credentials, PAT — role/grant sama seperti user | Tidak ada konsep bawaan (harus buat sendiri) | IdP/broker penuh per Organization | **AGPL-3.0** (v3+), commercial license tersedia | **Ya, gratis, termasuk grants/roles** | **Ya**, event-sourced, Event API + SIEM streaming — paling lengkap |
| **SuperTokens** | Core Apache 2.0 + Postgres, docker straightforward | Multi-tenancy = **"contact us" (berbayar)** | SDK per-framework | **M2M auth = "contact us" (berbayar)** | Tidak ada | — | Apache 2.0 core / ee proprietary | RBAC dasar gratis, **tapi 2 fitur yang kami butuh (multi-tenancy & M2M) berbayar** | Tidak digali lebih jauh — sudah gugur |
| **Custom di atas Postgres** | 0 container tambahan, tabel + middleware sendiri | 100% sesuai kosakata kami (Principal/Project/ProjectMembership) | Trivial, tak ada abstraksi bocor | Tabel credential sendiri, desain bebas | Tabel `runners` sendiri, `Runner ≠ Principal` terjaga secara struktural | Harus bangun sendiri (openid-client/saml2-js) | — (kode sendiri) | Ya, karena kami yang desain | Harus bangun sendiri (`audit_log` table) |

---

## Detail per kandidat

### 1. better-auth
- **Beban self-host**: library TypeScript, nempel langsung di proses
  Hono/Fastify — bukan servis terpisah. Pakai Postgres yang sudah ada via
  Drizzle/Prisma/Kysely adapter. **[terverifikasi: better-auth.com/docs/adapters/drizzle,
  better-auth.com/docs/installation]**
- **Model org**: plugin `organization()` — Organization → Member → Role.
  Default role owner/admin/member, role kustom via access-control plugin,
  user bisa multi-role & multi-org, ada konsep Team (sub-grup dalam org).
  **[terverifikasi: better-auth.com/docs/plugins/organization,
  github.com/better-auth/better-auth discussions #3317]**
- **Integrasi**: dokumentasi resmi untuk Hono dan Fastify. Default session
  cookie; plugin JWT opsional dengan JWKS + key rotation untuk verifikasi
  stateless lintas servis. **[terverifikasi: better-auth.com/docs/integrations/hono,
  /fastify, /docs/plugins/jwt]**
- **Auth mesin**: plugin API Key mendukung key milik organisasi (bukan cuma
  user), object `permissions`, expiry, rate-limit/refill. Tidak ada tipe
  "principal mesin" first-class — ServiceAccount harus dimodelkan sebagai
  baris user/member khusus yang memegang org-owned API key.
  **[terverifikasi: better-auth.com/docs/plugins/api-key]**
- **SSO**: plugin SSO terpisah, mendukung OIDC **dan** SAML2 sebagai SP,
  multi-domain provider, auto-provisioning ke organization saat login SSO.
  **[terverifikasi: better-auth.com/docs/plugins/sso,
  github.com/better-auth/better-auth/blob/main/docs/content/docs/plugins/sso.mdx]**
- **Lisensi & kematangan**: MIT. **[terverifikasi: GitHub API
  repos/better-auth/better-auth license field]**. Sangat aktif — push
  terakhir hari ini, 29.4k star, 631 open issue **[terverifikasi: GitHub API]**.
  Proyek relatif muda (mulai ~2024), belum ada rekam jejak jangka panjang.
- **Audit**: **titik lemah utama.** "Audit Logs" resmi disediakan lewat
  plugin `dash()` yang butuh `BETTER_AUTH_API_URL`,
  `BETTER_AUTH_KV_URL`, `BETTER_AUTH_API_KEY` — artinya menghubungi layanan
  hosted "Better Auth Infrastructure" milik vendor, bukan fitur
  self-hosted murni. Ini melanggar syarat "tanpa layanan pihak ketiga".
  **[terverifikasi: better-auth.com/docs/infrastructure/plugins/dash]**
  Ada plugin komunitas tak-resmi (`better-auth-audit-logs` oleh ejirocodes)
  yang katanya self-hosted, tapi belum saya audit isinya —
  **[kesan, cuma cek keberadaan repo]**.

### 2. Lucia
- **Deprecated Maret 2025.** Maintainer resmi menyatakan library "tidak
  bekerja efektif", beban kompleksitas dari database adapter kelewat besar
  dibanding manfaatnya. Semua adapter database dihentikan akhir 2024. Lucia
  sekarang jadi materi belajar "cara bikin auth dari nol", bukan dependency
  aktif — jangan dipakai sebagai library produksi.
  **[terverifikasi: github.com/lucia-auth/lucia discussions #1707 dan #1714]**
- Nilai sisa: pola yang diajarkan (token acak, hash-nya disimpan di server,
  token mentah di cookie HttpOnly) persis pola yang dipakai opsi "custom di
  atas Postgres" di bawah — dokumentasinya lumayan buat referensi walau
  paket-nya sendiri sudah mati.

### 3. Ory Kratos
- **Lisensi**: Apache 2.0 untuk core open source.
  **[terverifikasi: GitHub API repos/ory/kratos]**. Tapi **Organizations
  (B2B multi-tenancy), SAML, SCIM, multi-region hanya lewat Ory Enterprise
  License (OEL)** berbayar di atas self-hosted.
  **[terverifikasi: ory.com/kratos, hasil pencarian ory.com/docs/oel/kratos/install]**
- **Beban self-host**: Kratos sendirian **hanya identitas & kredensial** —
  tidak menerbitkan token OAuth2/OIDC, tidak ada authorization. Untuk
  M2M/service-account butuh **+Ory Hydra**. Untuk authorization
  halus butuh +Keto, untuk gateway pattern +Oathkeeper. Minimum realistis
  untuk kebutuhan kami (login manusia + token mesin) = **2 servis
  tambahan (Kratos+Hydra)**, masing-masing skema Postgres sendiri.
  **[terverifikasi: deepwiki.com/ory/kratos/10-integration-with-ory-ecosystem,
  github.com/ory/hydra]**
- **Model org**: OSS tidak punya konsep Organization/Project. Multi-tenancy
  bawaan cuma `network_id` (dipakai internal Ory Network untuk isolasi
  SaaS mereka, bukan unit organisasi level aplikasi). Untuk dapat
  Project-scoped membership, kami harus bangun sendiri di atas identity
  traits/metadata Kratos, atau bayar OEL.
- **Auth mesin**: Hydra menerbitkan token OAuth2 client-credentials — pola
  M2M yang legit dan umum. Tapi identitas Kratos dan client OAuth2 Hydra
  adalah dua jenis objek terpisah yang harus kami satukan sendiri.
- **Audit**: tidak ditemukan UI/API audit khusus di OSS — hanya log
  aplikasi biasa. **[kesan, tidak ditemukan dokumentasi resmi yang
  menyebut audit trail terstruktur di Kratos OSS — sudah dicari lewat
  ory.com/docs dan tidak muncul]**
- **Kematangan**: aktif, 13.8k star, push 2 hari lalu.
  **[terverifikasi: GitHub API]**

### 4. Keycloak
- **Lisensi**: Apache 2.0, dan **penting: Organizations sudah GA (stabil)
  sejak versi 26**, bukan fitur enterprise berbayar — masuk community
  edition penuh, sama seperti Realm/Client Roles.
  **[terverifikasi: GitHub API repos/keycloak/keycloak license;
  keycloak.org/2024/06/announcement-keycloak-organizations; dikonfirmasi
  status GA lewat pencarian skycloak.io/blog/keycloak-vs-zitadel-comparison
  — catatan: sumber GA-nya artikel pihak ketiga, bukan release note resmi
  yang saya baca langsung, jadi tandai [kesan] untuk detail versi persisnya]**
- **Beban self-host**: 1 container JVM (Quarkus-based) + Postgres sendiri.
  Lebih berat dibanding opsi Node/Go (footprint JVM), tapi cuma 1 servis.
  Angka RAM spesifik tidak saya temukan di dokumentasi resmi dalam sesi
  ini — **tidak ditemukan**, sudah dicari via keycloak.org/docs/latest.
- **Model org**: Realm (isolasi level atas, biasanya 1 realm per
  perusahaan) → **Organizations** (grouping B2B di dalam realm, GA v26) →
  Groups → Realm/Client Roles. Organizations cocok dipetakan ke Project.
  **[terverifikasi: keycloak.org/2024/06/announcement-keycloak-organizations]**
- **Auth mesin**: Client Credentials grant lewat confidential Client +
  **Service Accounts** (tiap Client bisa diaktifkan Service Account-nya,
  role diberikan langsung ke situ). Cocok untuk pola ServiceAccount, tapi
  butuh desain: 1 Client per Project, atau 1 Client shared dengan role
  per-organization. **[terverifikasi: hasil pencarian dokumentasi resmi
  service-accounts Keycloak]**
- **SSO**: ini kompetensi inti Keycloak — dia sendiri IdP/broker penuh ke
  upstream OIDC/SAML, jalur SSO nanti sangat matang.
- **Audit**: **bawaan** — Login Events + Admin Events, di-toggle per realm,
  tersimpan di DB, ada Listener SPI untuk sink kustom.
  **[terverifikasi: hasil pencarian dokumentasi resmi Keycloak Auditing and
  Events]**
- **Kematangan**: proyek tertua di daftar ini (asal dari era
  JBoss/Red Hat), 35.9k star, issue tracker paling aktif, push hari ini.
  **[terverifikasi: GitHub API]**

### 5. Authentik
- **Lisensi**: MIT untuk kode inti; direktori `authentik/enterprise/`
  punya lisensi proprietary terpisah; JS client-side MIT juga.
  **[terverifikasi: raw LICENSE file di
  github.com/goauthentik/authentik, dibaca langsung]**
- **Beban self-host**: docker-compose = server + worker + Postgres +
  Redis (+reverse proxy opsional). Angka "~600MB idle di 4vCPU/8GB" saya
  temukan di blog pihak ketiga (SimpleHomelab/OneUptime), **bukan dari
  dokumentasi resmi Authentik — [kesan]**, tidak saya verifikasi ke
  docs.goauthentik.io langsung.
- **Model org**: Groups + object-level permission (gaya django-guardian).
  Ada fitur "Tenants" (sejak 2024.2) tapi itu untuk menjalankan beberapa
  **instalasi Authentik terpisah** (skema Postgres terpisah per tenant,
  branding/install ID sendiri) — **bukan** abstraksi per-Project membership
  yang kami mau. Untuk kebutuhan kami harus dibangun sendiri di atas
  Groups. **[terverifikasi: docs.goauthentik.io/sys-mgmt/tenancy]**
- **Auth mesin**: ada API token untuk memanggil API Authentik sendiri
  (dipakai Outpost), auto-generate + scoped. Untuk service account
  aplikasi kami sendiri, tetap harus pasang OAuth2 Provider dan pakai
  client-credentials — kurang first-class dibanding Zitadel.
  **[terverifikasi: docs.goauthentik.io/sys-mgmt/service-accounts]**
- **Audit**: **bawaan dan cukup lengkap** — unified Event system mencatat
  tiap login, perubahan policy, modifikasi model.
  **[terverifikasi: docs.goauthentik.io via deepwiki summary
  "Events and Audit Logging"]**
- **Kematangan**: MIT core, 22.6k star, aktif, push hari ini.
  **[terverifikasi: GitHub API]**

### 6. Zitadel
- **Lisensi**: **AGPL-3.0-only** sejak v3 (sebelumnya Apache 2.0 sampai
  v2). Ada commercial license berbayar buat yang mau lepas dari kewajiban
  copyleft AGPL. **[terverifikasi: GitHub API repos/zitadel/zitadel
  license; github.com/zitadel/zitadel/blob/main/LICENSING.md;
  zitadel.com/blog/zitadel-v3-announcement]**
- **Beban self-host**: **paling ringan** di antara opsi "IdP penuh" —
  1 binary/container Go (API) + 1 container login UI (Next.js, sejak v3) +
  **Postgres saja**, tanpa Redis. Dukungan CockroachDB sudah dihapus di
  v3+. Test env: 1 CPU/512MB cukup. Produksi: ~512MB untuk Zitadel,
  total ~4-6GB dengan Postgres caching, 2 CPU minimum/4 direkomendasikan
  (untuk password hashing di bawah beban), disk minimum 10GB. Wajib ada
  masterkey 32-karakter untuk enkripsi rahasia at-rest — hilang kunci ini
  = kehilangan akses total ke data terenkripsi.
  **[terverifikasi: zitadel.com/docs/self-hosting/manage/requirements,
  zitadel.com/docs/self-hosting/deploy/compose — via ringkasan pencarian,
  bukan saya baca utuh]**
- **Model org**: **Organization → Project → Role → Grant/Role-Assignment**,
  plus Project Grant untuk mendelegasikan akses project ke organization
  lain. Ini yang **paling pas secara struktural** dengan kosakata kami —
  Organization (atau Project Zitadel, tergantung level yang dipilih) bisa
  dipetakan langsung ke Project kami, role+grant = role membership.
  **[terverifikasi: zitadel.com/docs/guides/manage/console/organizations-overview,
  /projects-overview, /concepts/structure/granted_projects]**
- **Auth mesin — ini yang menentukan**: Zitadel punya **Service Accounts**
  first-class (istilah resminya sekarang "Service Accounts", dulu disebut
  Service User/Machine User/Technical Account — nama disatukan). Tiga
  metode auth: **Private Key JWT profile** (RFC 7523 JWT-bearer),
  **OAuth2 Client Credentials**, dan **Personal Access Token** (bearer
  token siap pakai, khusus untuk service account, bukan user manusia).
  Semua mendukung expiry, dan role/grant diberikan ke service account
  **persis seperti** ke user manusia — satu sistem RBAC untuk dua jenis
  Principal. **[terverifikasi: zitadel.com/docs/guides/integrate/service-accounts/authenticate-service-accounts,
  /private-key-jwt, /personal-access-token, /client-credentials]**
- **SSO**: Zitadel sendiri IdP/broker OIDC+SAML penuh, bisa federasi ke
  upstream IdP korporat per Organization — jalur SSO nanti tidak perlu
  ganti sistem.
- **Audit**: **paling lengkap** di antara semua kandidat — arsitektur
  event-sourced, tiap mutasi tersimpan sebagai event immutable, ada
  Event API buat query terprogram, plus fitur khusus streaming audit log
  ke SIEM/SOC eksternal. **[terverifikasi: zitadel.com/docs/concepts/features/audit-trail,
  /guides/integrate/external-audit-log, /guides/integrate/zitadel-apis/event-api]**
- **Kematangan**: 14.6k star, sangat aktif (push hari ini, 1083 open
  issue). **[terverifikasi: GitHub API]** Catatan lisensi: AGPL-3.0 punya
  kewajiban copyleft kalau memodifikasi dan menyediakannya sebagai layanan
  lewat jaringan ke pihak lain. Untuk pemakaian **internal murni** (bukan
  ditawarkan sebagai servis ke pelanggan eksternal), risiko legalnya
  rendah, tapi tetap sebaiknya dicek sekali oleh legal — terutama kalau
  suatu saat "distributed software factory" ini mau ditawarkan ke luar tim.

### 7. SuperTokens — gugur
- **Lisensi**: Apache 2.0 untuk kode di luar direktori `ee/`, proprietary
  di dalamnya. **[terverifikasi: raw LICENSE.md di
  github.com/supertokens/supertokens-core, dibaca langsung]**
- **Tapi secara fungsional gugur** untuk kebutuhan kami: halaman pricing
  resmi menyatakan **Multi-tenancy & Organisational support = "Contact
  us"/berbayar**, dan **M2M (machine-to-machine) auth = fitur baru,
  "Contact us"/berbayar** juga. RBAC dasar sendiri gratis, tapi dua fitur
  yang paling kami butuhkan — model Project (multi-tenancy) dan auth
  ServiceAccount (M2M) — dua-duanya terkunci di belakang kontak sales.
  **[terverifikasi: WebFetch langsung ke supertokens.com/pricing]**
  Ini persis kriteria gugur yang disebutkan: RBAC/kapabilitas inti terkunci
  di edisi berbayar. Saya berhenti menggali lebih dalam karena sudah jelas
  tidak lolos syarat wajib.

### 8. Session custom di atas Postgres
- **Beban self-host**: nol container tambahan — cuma tabel
  (`principals`/`users`/`service_accounts`, `sessions`, `runners`,
  `project_memberships`, `audit_log`) di Postgres yang sudah ada, plus
  middleware Hono/Fastify. Pola standar (sama yang dulu diajarkan Lucia):
  token acak ≥128-bit, yang disimpan di server **hash SHA-256-nya saja**
  (bukan token mentah), dikaitkan ke `principal_id` + `expires_at`; browser
  pegang token mentah di cookie `HttpOnly; Secure; SameSite`.
  **[kesan — ini pola keamanan sesi yang umum/OWASP-style, bukan dari satu
  sumber tunggal yang saya verifikasi ulang sesi ini]**
- **Model org**: 100% sesuai kosakata — tabel `project_memberships(principal_id,
  project_id, role)` langsung memetakan Principal↔Project↔role tanpa
  translasi dari konsep asing (Organization/Tenant/Team) milik produk lain.
- **Integrasi**: trivial — middleware baca cookie, hash, query 1 baris
  (atau cache), taruh principal di context. Tidak ada abstraksi bocor,
  tidak dipaksa framework tertentu.
- **Auth mesin**: skema credential yang sama diperluas — ServiceAccount
  dapat API key (hash disimpan sama seperti session, expiry panjang/tanpa
  expiry + rotasi manual), Runner dapat jenis credential sendiri yang
  diterbitkan saat join-token ditukar. Karena skema kami yang desain,
  invarian **"Runner bukan Principal"** ditegakkan secara struktural
  (Runner tidak punya baris di tabel `principals` sama sekali) — sesuatu
  yang tidak diberikan gratis oleh IdP off-the-shelf manapun di atas;
  semuanya akan menyatukan Runner ke tipe "machine/service" generik
  kecuali kami buat workaround.
- **SSO**: tidak ada bawaan — harus pasang `openid-client`/`saml2-js`
  sendiri nanti. Ini biaya nyata: SSO jadi "bangun sendiri", bukan
  "nyalakan config flag" seperti di Keycloak/Zitadel/Authentik.
- **Kematangan & lisensi**: tidak relevan — kode sendiri, tanpa risiko
  vendor/lisensi. "Kematangan" = seberapa hati-hati tim menangani
  fixation, rotasi, timing-safe compare, CSRF.
- **Audit**: tidak bawaan — tulis sendiri tabel `audit_log` dan insert di
  tiap mutasi privileged. Effort-nya kira-kira sama dengan yang harus
  ditulis sendiri untuk domain-level audit (perubahan Project/Pipeline)
  di atas IdP manapun kecuali Zitadel/Keycloak/Authentik yang audit
  bawaan-nya memang menyasar level identity/authz, bukan domain kami.

---

## Auth mesin — jawaban tegas untuk pertanyaan #4

**Satu sistem untuk User+ServiceAccount, sistem terpisah untuk Runner.**

Alasannya bertingkat:

1. **User dan ServiceAccount sama-sama Principal** dalam kosakata kalian
   sendiri — sama-sama butuh keanggotaan Project, role, dan credential yang
   bisa dicabut/diaudit. Memisahkannya ke dua sistem auth cuma menambah
   permukaan untuk sinkronisasi role yang gampang drift (role User di
   sistem A, role ServiceAccount di sistem B, harus tetap konsisten
   secara manual). **Zitadel** membuktikan satu sistem sanggup menerbitkan
   dan memverifikasi keduanya dengan model role/grant yang identik — bukan
   fitur "juga bisa buat mesin" ditempel belakangan, tapi memang didesain
   begitu (istilah resminya "Service Accounts", role diberikan lewat
   mekanisme Grant yang sama persis dengan user manusia).
   **[terverifikasi: dokumentasi service-accounts Zitadel di atas]**

2. **Runner bukan Principal** — sudah kalian tegaskan sendiri di kosakata.
   Dia tidak butuh keanggotaan Project atau role; dia butuh **tepat satu
   hal**: menukar join token sekali pakai dengan credential berumur
   panjang yang dipakai buat menarik kerja. Memaksakan Runner masuk ke
   model "machine principal" generik milik sebuah IdP (Zitadel Service
   Account, Keycloak Client, dsb.) berarti dia otomatis kebagian
   kemampuan yang tidak relevan (role di Project, kemampuan login
   OAuth) yang harus kalian batasi manual — menambah permukaan, bukan
   menguranginya.

3. **Preseden dari sistem CI yang sudah production-grade** menunjukkan pola
   join-token-lalu-tukar-credential ini memang biasa dipisahkan dari IdP
   umum:
   - GitHub Actions self-hosted runner: registration token (kadaluarsa
     1 jam, sekali pakai) ditukar jadi runner-specific token saat
     registrasi — bukan lewat OAuth/OIDC flow milik GitHub yang dipakai
     user manusia. **[terverifikasi: docs.github.com/en/rest/actions/self-hosted-runners,
     via ringkasan pencarian]**
   - Kubernetes kubelet TLS bootstrapping: bootstrap token dipakai sekali
     buat minta client certificate (CSR), setelah disetujui, node pakai
     certificate itu (mTLS) untuk semua interaksi selanjutnya — bootstrap
     token itu sendiri eksplisit "bukan identitas permanen", cuma
     jembatan sekali pakai. **[terverifikasi: kubernetes.io/docs/reference/access-authn-authz/bootstrap-tokens/,
     via ringkasan pencarian]**

   Kedua sistem ini sengaja **tidak** merutekan registrasi mesin lewat
   sistem identitas user mereka (GitHub App/OAuth, atau IdP korporat) —
   mereka pakai mekanisme token-tukar-credential yang purpose-built dan
   minimal.

**Rekomendasi konkret untuk Runner**: jangan didaftarkan ke Zitadel (atau
IdP manapun) sama sekali. Bikin tabel `runners` sendiri di Postgres yang
sama (id, name, project_id kalau Runner mau discope ke Project, `join_token_hash`
yang langsung dihapus/invalidate sekali dipakai, `credential_hash`,
`status`, `last_seen_at`), satu endpoint join yang menukar join token jadi
credential (bearer token panjang, atau mTLS client cert kalau mau ikatan
lebih kuat), dan middleware kecil di control plane buat verifikasi. Ini
±100-150 baris kode, nol infra tambahan, dan invarian "Runner ≠ Principal"
tetap terjaga oleh struktur tabel, bukan cuma konvensi.

---

## Rekomendasi

**Zitadel, self-hosted, untuk User + ServiceAccount. Runner ditangani
sendiri di atas Postgres, terpisah total dari Zitadel.**

Kenapa Zitadel menang lawan kandidat lain:

- **Model org paling pas** — Organization→Project→Role→Grant sudah
  nyaris identik ke Principal/Project/role kalian, tanpa translasi
  konsep asing seperti di Kratos (harus dibangun sendiri atau bayar OEL)
  atau Authentik (Tenant = install terpisah, salah level abstraksi).
- **Satu-satunya yang punya "Service Account" first-class** dengan 3
  metode auth mesin (JWT profile, client credentials, PAT) dan role
  sistem yang sama dengan user manusia — langsung jawab kriteria #4 tanpa
  perlu jahit-menjahit.
- **Audit trail paling lengkap dan gratis** — event-sourced, tiap mutasi
  jadi event immutable, ada Event API dan SIEM streaming, tanpa bayar
  apa pun. Keycloak dan Authentik juga bawaan (bagus), tapi model org
  keduanya (Realm+Organizations vs Groups+Tenants-terpisah) kalah pas
  dibanding Zitadel.
- **RBAC & multi-tenancy tidak terkunci di edisi berbayar** — beda dari
  SuperTokens (gugur) dan Ory Kratos (org-nya OEL).
  Semua yang kalian butuh (Organization, Project, Role, Grant, Service
  Account) ada di edisi AGPL gratis.
- **Beban infra paling ringan** di antara IdP penuh: 1 binary Go + 1
  login UI container + Postgres saja, tanpa Redis, tanpa DB terpisah dari
  yang sudah kalian punya.
- **Satu risiko nyata: lisensi AGPL-3.0.** Untuk pemakaian internal
  (tidak ditawarkan sebagai layanan ke pihak luar), kewajiban copyleft-nya
  praktis tidak ke-trigger. Kalau suatu saat orkestrator ini mau
  ditawarkan sebagai produk/layanan ke luar tim, ini butuh keputusan
  legal ulang (pakai commercial license Zitadel, atau audit ulang
  kandidat). Catat ini sebagai keputusan yang perlu ditinjau ulang saat
  konteks berubah, bukan blocker sekarang.

**Alternatif yang sah kalau mau minimalkan infra & risiko lisensi lebih
jauh**: sesi custom di atas Postgres (opsi #8). Untuk satu tim internal
dengan jumlah Project/User yang kecil, ini konsisten dengan YAGNI/KISS —
tidak ada dependency baru, tidak ada isu lisensi, model Project 100% pas
tanpa translasi. Trade-off-nya: audit trail dan SSO harus dibangun sendiri
(bukan besar, tapi nyata), dan kalian menanggung sendiri kebenaran
kriptografi/keamanan sesi. Saya condong ke Zitadel karena syarat #7
(audit) dan #2 (role per-Project) kalian nyatakan eksplisit sebagai
kebutuhan, dan Zitadel memberi keduanya gratis tanpa effort bangun — tapi
kalau tim menilai audit trail & SSO belum perlu dalam waktu dekat, opsi
custom-Postgres adalah pilihan yang lebih ringan dan sama validnya, tinggal
tunda keputusan IdP sampai kebutuhan itu benar-benar muncul.

---

## Yang tidak saya verifikasi / batasan riset

- Tidak ada instalasi/uji coba langsung — semua klaim dari dokumentasi
  resmi, GitHub API, atau ringkasan hasil pencarian (yang kadang
  merangkum dari blog pihak ketiga; ditandai [kesan] di tempatnya).
- Angka RAM Keycloak: **tidak ditemukan** di docs resmi dalam sesi ini.
- Detail biaya Zitadel Enterprise Self-Hosted (untuk yang mau commercial
  license lepas AGPL): tidak digali, di luar cakupan pertanyaan.
- Format audit event Zitadel/Keycloak/Authentik secara persis (skema
  field) tidak dibandingkan detail — cuma keberadaan & aksesibilitasnya.
