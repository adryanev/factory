# Pilihan auth yang bisa self-hosted untuk monorepo TypeScript

Type: research
Status: resolved
Blocked by: —

## Question

Untuk control plane TypeScript yang harus bisa di-self-host penuh oleh sebuah tim internal, pilihan auth apa saja yang tersedia dan apa harga masing-masing?

Bandingkan setidaknya: **better-auth**, **Lucia** (dan status pemeliharaannya), **Ory Kratos**, **Keycloak**, **Authentik**, **Zitadel**, dan opsi menulis session sendiri di atas Postgres. Untuk tiap pilihan:

1. **Beban self-host** — berapa container tambahan, ketergantungan pada DB terpisah, kebutuhan memori, dan kerumitan konfigurasi awal.
2. **Model tim/organisasi** — apakah ada konsep organisasi, keanggotaan, dan peran bawaan, atau harus kita bangun sendiri di atasnya.
3. **Integrasi** — seberapa mulus dengan Hono/Fastify dan React SPA. Session cookie atau JWT. Bagaimana route API dilindungi.
4. **Auth mesin** — ini yang paling menentukan: bisakah pilihan yang sama menerbitkan dan memverifikasi credential **non-manusia** untuk worker (join token → worker credential berumur panjang), atau apakah auth worker harus jadi jalur yang benar-benar terpisah. Catat apa yang biasanya dilakukan sistem CI.
5. **SSO** — jalur ke OIDC/SAML kalau nanti org butuh, tanpa harus mengganti seluruh pilihan.
6. **Kematangan** — tanggal rilis terakhir, ukuran komunitas, dan apakah ada tanda proyek ditinggalkan.

Keluaran: `.scratch/distributed-software-factory/research/self-hosted-auth.md`, dengan tabel perbandingan dan satu rekomendasi beserta alasannya. Sebutkan tegas kalau auth manusia dan auth worker sebaiknya dipisah.

## Answer

Laporan lengkap: [`research/self-hosted-auth.md`](../research/self-hosted-auth.md), 407 baris, 35 klaim bertanda terverifikasi.

**Rekomendasi: Zitadel untuk Principal, jalur terpisah buatan sendiri untuk Runner.**

Zitadel memetakan hampir 1:1 ke kosakata kita — Organization → Project → Role → Grant. ServiceAccount adalah kelas satu (JWT profile, client credentials, PAT) dengan role yang sama seperti User, jadi kedua jenis Principal ditangani satu sistem tanpa dipaksakan. Audit trail event-sourced lengkap dan gratis. Infra paling ringan di antara kandidat penuh: satu binary Go + Postgres, tanpa Redis.

**Runner sengaja tidak didaftarkan ke Zitadel.** Buat tabel `runners` sendiri plus endpoint pertukaran join token di Postgres yang sama, sekitar 100–150 baris. Ini pola yang dipakai GitHub Actions self-hosted runner dan bootstrap token kubelet Kubernetes — keduanya sengaja memisahkan identitas mesin dari sistem identitas user. Efek sampingnya bagus: invarian **Runner ≠ Principal** terjaga secara struktural, bukan cuma sebagai konvensi.

**Yang gugur, dan alasannya:**

- **SuperTokens** — multi-tenancy *dan* M2M auth dua-duanya di balik "contact us". Persis kriteria diskualifikasi.
- **Ory Kratos** — OSS-nya hanya identitas; M2M butuh Hydra (dua servis tambahan), dan Organization/B2B dikunci di lisensi enterprise berbayar.
- **Lucia** — deprecated Maret 2025, sekarang learning resource.
- **better-auth** — MIT dan ringan, tapi fitur audit log resminya memanggil layanan hosted "Better Auth Infrastructure". Bukan self-hosted murni. Ini jenis jebakan yang baru ketahuan setelah dipasang.
- **Keycloak** dan **Authentik** — keduanya solid, RBAC dan org gratis penuh, audit bawaan. Tapi model org-nya kurang pas: "Tenant" Authentik berarti instalasi terpisah, bukan unit per-Project.

**Dua catatan yang harus dibawa ke ticket 11:**

1. **Zitadel berlisensi AGPL-3.0.** Untuk pemakaian internal risikonya rendah. Tapi kalau factory ini nanti ditawarkan ke luar tim, ini harus ditinjau ulang — dan destination map ini sudah menyebut tim internal, jadi perubahan itu berarti destination baru.
2. **Alternatif yang tetap hidup**: session custom di atas Postgres. Cocok penuh secara model, infra paling minim, tidak ada AGPL. Harganya audit trail dan SSO dibangun sendiri. Riset memilih Zitadel karena audit trail dan role per-Project disebut eksplisit sebagai kebutuhan — kalau ticket 11 memutuskan audit bawaan tidak sepadan dengan satu servis tambahan, opsi ini yang menang.

Ticket 11 yang memutuskan; ticket ini hanya menyediakan pilihannya.
