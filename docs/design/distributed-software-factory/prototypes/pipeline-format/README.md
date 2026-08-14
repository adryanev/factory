# PROTOTYPE — sekali pakai, jangan dipelihara

Artefak untuk ticket [09](../../issues/09-prototype-pipeline-definition-format.md).
Bukan spec, bukan skema final. Dibuat untuk direaksi lalu dibuang.

Tiga gaya × tiga pipeline acuan yang sama:

| | acuan 1 — fan-out + HITL | acuan 2 — rantai lurus | acuan 3 — lintas repo |
|---|---|---|---|
| **A** GitHub Actions | [a-gha/01](a-gha/01-fanout-review.yaml) | [a-gha/02](a-gha/02-linear.yaml) | [a-gha/03](a-gha/03-cross-repo.yaml) |
| **B** Argo/Temporal | [b-argo/01](b-argo/01-fanout-review.yaml) | [b-argo/02](b-argo/02-linear.yaml) | [b-argo/03](b-argo/03-cross-repo.yaml) |
| **C** paling sedikit basa-basi | [c-minimal/01](c-minimal/01-fanout-review.yaml) | [c-minimal/02](c-minimal/02-linear.yaml) | [c-minimal/03](c-minimal/03-cross-repo.yaml) |
| **D** hasil — rangka A, cabang C | [d-verdict/01](d-verdict/01-fanout-review.yaml) | [d-verdict/02](d-verdict/02-linear.yaml) | [d-verdict/03](d-verdict/03-cross-repo.yaml) |

**D adalah yang dipilih.** A, B, dan C ditinggalkan apa adanya sebagai bahan
perbandingan — termasuk `a-gha/03` yang sengaja dibiarkan tidak valid.

Acuan 1: `plan → {agent A, B, C} → pick-best → review(manusia) → test`
Acuan 2: `lint → build → test` — satu repo, tanpa fan-out, tanpa manusia
Acuan 3: `plan → {frontend, backend} → join`

## Yang sudah dikunci dan tidak dipertanyakan kandidat mana pun

YAML, satu file satu Pipeline, `version: 1`, tanpa ekspresi, satu Step satu repo,
tanpa `uses:` lintas file. `on:`/trigger sengaja tidak ditulis di mana pun — itu
milik ticket 22 yang masih terbuka.

## Dua tempat semua gaya paling mungkin runtuh

Keduanya baru terlihat setelah file sungguhannya ditulis, dan keduanya adalah
pertanyaan yang harus dijawab sebelum skema Zod ditulis.

### 1. Rujukan ke Output tanpa ekspresi

Ticket 06 menulis `over: ${{ plan.variants }}`. Ticket 08 melarang interpolasi
yang dievaluasi. Jadi bentuk itu mati dan penggantinya harus data. Tiga kandidat
menjawabnya berbeda — lihat baris `over:`/`forEach:` di acuan 1 tiap gaya.

### 2. Cabang yang berbeda agent

Acuan `{agent A, B, C}` menuntut tiap cabang memakai agent berbeda. Tanpa
ekspresi, elemen `over:` tidak bisa disubstitusikan ke bidang `agent:` — kalau
bisa, itu interpolasi dengan nama lain. Yang tersisa dua jalan, dan tiap gaya
memilih beda:

- elemen `over:` boleh **menimpa** daftar bidang tertutup (gaya A dan C), atau
- elemen `over:` **menunjuk templat** di file yang sama (gaya B).

Kalau tidak satu pun diterima, konsekuensinya harus dinyatakan: acuan
`{agent A, B, C}` tidak bisa ditulis, dan fan-out hanya untuk cabang seragam.
