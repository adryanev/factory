# Notifikasi: bagaimana seseorang tahu ada Question yang menunggu dia

Type: grilling
Status: resolved
Blocked by: —

## Question

Sebuah Interactive Step menerbitkan Question dan lalu diam. Bagaimana manusia yang dituju tahu bahwa ia sedang ditunggu?

Digraduasi dari kabut setelah ticket 14 (bentuk Interactive Step) dan ticket 11 (model tim dan peran) selesai. Keduanya sudah memberi bahan yang dibutuhkan, jadi pertanyaannya sekarang bisa dirumuskan tajam.

Yang sudah dikunci dan jadi premis:

- Question ditujukan ke **audiens**, bukan individu (`ask: role("reviewer")`, bawaan `trigger()`) — jawaban pertama menang lewat compare-and-set, penjawab selalu dicatat (ticket 14).
- **Tanpa kadaluarsa bawaan.** Ticket 14 memutuskan menggantung tidak menyandera apa pun, dan menulis eksplisit: *"visibilitas menggantikan timer."* Ticket ini yang harus membayar janji itu.
- Peran: `admin` + `member` per Project, `owner` di level org (ticket 11).
- "Menunggu manusia" bukan status Run — ticket 05 menyatakan pertanyaan yang sebenarnya orang ajukan adalah *"apa yang menunggu **saya**"*, dan itu kueri atas Question.

Yang harus diputuskan:

1. **Kanal** — lencana di UI saja, email, Slack, atau kombinasi. Ingat constraint self-hosted: Slack berarti ketergantungan keluar, email berarti SMTP yang harus dikonfigurasi operator. Apa yang minimum untuk membuat "visibilitas menggantikan timer" jadi benar, bukan sekadar tertulis?
2. **Penargetan** — Question ditujukan ke audiens. Notifikasi ikut ke seluruh audiens, atau ada mekanisme penugasan supaya sepuluh orang tidak dapat sepuluh notifikasi untuk satu pertanyaan?
3. **Pengingat** — kalau tidak ada kadaluarsa, apakah ada pengingat berkala? Setiap berapa lama, dan berhenti kapan? Ini satu-satunya timer yang mungkin tersisa di sistem, jadi keberadaannya harus dibela.
4. **Preferensi per-User** — bisakah orang mematikan kanal tertentu, atau ini seragam per Project? Uji apakah preferensi memang dibutuhkan atau cuma kompleksitas yang ditiru dari produk lain.
5. **Kejadian selain Question** — apakah Run gagal, Run selesai, dan Runner offline juga memicu notifikasi, atau ticket ini sengaja dibatasi ke Question saja? Melebarkannya sekarang lebih murah daripada menambal belakangan, tapi hanya kalau memang dibutuhkan.
6. **Batalnya notifikasi** — Question sudah dijawab orang lain, atau Run di-cancel selagi menggantung. Apa yang terjadi pada notifikasi yang sudah terkirim, dan pada lencana yang masih menyala.
7. **Digest versus seketika** — fan-out 50 cabang yang semuanya bertanya menghasilkan 50 Question sekaligus. Apakah itu 50 notifikasi?

Zoom ke jawaban ticket 14 untuk bentuk Question dan ke ticket 11 untuk peran dan keanggotaan.

## Answer

Janji ticket 14 — *"visibilitas menggantikan timer"* — dibayar **secara harfiah**: yang membuat orang tahu ia sedang ditunggu adalah **state yang terbaca**, bukan kejadian yang dikirim. Konsekuensinya rantai keputusan yang lain jatuh sendiri, termasuk sub-pertanyaan 6 yang lunas tanpa satu baris kode.

### Lencana adalah kueri, bukan tabel

Keputusan yang menopang seluruh sisanya, dan ia diambil lebih dulu karena ia yang menentukan bentuk sisanya.

Lencana "ada yang menunggu kamu" **bukan** baris notifikasi yang dibuat, ditandai terbaca, dan dibersihkan. Ia adalah kueri:

```sql
SELECT ... FROM questions q
WHERE q.answered_at IS NULL
  AND q.run_id IN (run yang belum berakhir)
  AND q.group_id IN (group yang memuat saya)
```

Ticket 05 sudah menyatakan pertanyaan yang sebenarnya orang ajukan adalah *"apa yang menunggu **saya**"*, dan itu kueri atas Question. Ticket ini cuma menolak godaan untuk membuat salinannya.

Sub-pertanyaan 6 **lunas sebagai akibat**: Question dijawab orang lain ⇒ `answered_at` terisi ⇒ lencana padam di semua orang, serentak, tanpa pembersihan. Run di-cancel selagi menggantung ⇒ Run berakhir ⇒ lencana padam. Tidak ada state notifikasi yang bisa basi, karena tidak ada state notifikasi.

Halaman **"Menunggu saya"** adalah kueri yang sama dalam bentuk daftar, **diurutkan menurut umur, dengan umurnya tertulis**. Itu permukaan utama fitur ini — bukan pelengkap dari kanal keluar.

### Dua kanal, dan email bukan salah satunya

Sub-pertanyaan 1. Yang dibangun:

1. **In-app** — lencana + halaman "Menunggu saya" di atas. Tidak bisa dimatikan, karena ia bukan pengiriman melainkan tampilan dari state.
2. **Satu outgoing webhook per Project** — URL + secret opsional, disetel `admin`. Payload JSON milik kita, dengan satu field `text` berisi kalimat manusia.

**Email ditolak.** SMTP yang harus dikonfigurasi operator, deliverability, template, alamat yang bounce, dan jalur unsubscribe — semua itu biaya nyata untuk kanal yang tim internal tidak baca lebih cepat daripada chat yang sudah mereka buka sepanjang hari.

**Integrasi Slack ditolak, webhook generik dipilih.** Bedanya penting untuk constraint self-hosted: nol kode vendor, nol OAuth app, nol ketergantungan keluar di dalam sistem. Operator yang memakai Slack menempelkan incoming-webhook URL-nya; yang memakai Discord atau Mattermost menempelkan miliknya; yang tidak memakai apa pun mengosongkannya dan sistem tetap utuh karena kanal in-app berdiri sendiri.

Field `text` disertakan supaya Slack menerimanya apa adanya. Harganya dinyatakan: platform yang formatnya berbeda butuh relay 10 baris dari operator. Itu murah, dan alternatifnya adalah menumbuhkan adaptor per vendor di dalam produk.

### Notifikasi ke channel, bukan ke orang

Sub-pertanyaan 2. Question ditujukan ke **Group** (ticket 14, dikoreksi ticket 08 jadi `ask: { group: reviewer }`), dan notifikasi mengikuti bentuk itu: **satu pesan per Question ke satu channel Project.**

Tidak ada mekanisme penugasan. Menugaskan Question ke satu orang berarti membangun sistem penjadwalan kedua — antrean per orang, penugasan ulang saat cuti, eskalasi saat diam — dan itu membatalkan keputusan ticket 14 bahwa jawaban pertama menang lewat compare-and-set.

Kekhawatiran "sepuluh orang dapat sepuluh notifikasi" **tidak pernah terjadi**, dan bukan karena ditambal: tidak ada kanal per-orang untuk dikirimi. Yang per-orang adalah lencana, dan lencana tidak dikirim.

### Tanpa pengingat berkala; umur yang menggantikannya

Sub-pertanyaan 3, dan ini yang harus dibela paling keras karena ia satu-satunya tempat timer bisa masuk kembali.

**Tidak ada pengingat per-Question.** Bukan setiap 24 jam, bukan eskalasi setelah 3 hari, bukan apa pun.

Pembelaannya: ticket 14 menolak kadaluarsa dengan alasan menggantung tidak menyandera apa pun — Sandbox sudah dilepas, Runner sudah bebas, biaya infra nol. Pengingat berkala mengembalikan tekanan waktu yang justru dibuang di sana, dan ia punya mode kegagalan yang khas: pengingat yang terlalu sering diabaikan orang, pengingat yang terlalu jarang tidak menolong.

Yang dipakai sebagai gantinya adalah **umur yang terlihat**, di tiga tempat:

- Halaman "Menunggu saya" diurutkan menurut umur, umurnya tertulis di tiap baris.
- Daftar Run menandai Run yang tersumbat menunggu manusia lebih dari 24 jam.
- Halaman Run menandai cabang mana yang jadi sumbatnya (ticket 06: satu cabang `awaiting-human` bisa menahan Join `all` selamanya).

Satu-satunya timer yang diizinkan adalah **digest harian per Project**, satu pesan ke webhook, hanya kalau ada yang menunggu lebih dari 24 jam. Pembelaannya berbeda kelas dari pengingat: ia **membaca state, bukan mengejar sebuah Question**; ia idempoten; ia tidak mengeskalasi, tidak mengubah apa pun, dan tidak pernah menggagalkan apa pun. Tanpanya, Question yang terbit Jumat sore tenggelam di channel dan baru ditemukan Senin — dan itu persis kegagalan yang "visibilitas menggantikan timer" janjikan tidak terjadi.

### Tanpa preferensi per-User

Sub-pertanyaan 4. **Tidak ada.** Uji yang diminta ticket ini dijalankan dan hasilnya kosong: dari dua kanal yang tersisa, satu tidak masuk akal untuk dimatikan (lencana adalah tampilan state, mematikannya berarti menyembunyikan pekerjaan sendiri) dan satu lagi tidak per-orang (channel Project). Tidak tersisa apa pun untuk dipreferensikan.

Satu-satunya setelan yang ada: URL webhook per Project, milik `admin`. Preferensi per-User adalah kompleksitas yang ditiru dari produk yang punya sepuluh kanal, dan kita punya dua.

### Kejadian: Question terbit dan Run gagal

Sub-pertanyaan 5. Webhook menyala untuk **dua** kejadian:

- **Question terbit** — inti ticket ini.
- **Run gagal** — dan ini dimasukkan bukan karena melebarkan itu murah, tapi karena ticket 22 membuatnya wajib: Run yang dipicu Automation berjalan sebagai ServiceAccount, jadi **tidak ada manusia yang bisa diberi tahu secara personal**. Tanpa notifikasi berskala Project, cron yang gagal tiap malam gagal dalam senyap.

**Run selesai sukses: tidak.** Sukses adalah keadaan normal, dan memberitakan keadaan normal adalah cara tercepat membuat orang berhenti membaca channel-nya.

**Runner offline: tidak.** Ia terbaca di halaman Runner, dan ticket 06 sudah menandai StepRun yang tidak terjadwal lebih dari 5 menit di UI. Harganya dinyatakan: Runner yang mati tengah malam baru ditemukan pagi, dan sementara itu pekerjaan mengantre alih-alih gagal. Menambahkannya nanti aditif — satu jenis kejadian lagi di jalur yang sama.

### Digest versus seketika: coalescing 60 detik

Sub-pertanyaan 7. Fan-out 50 cabang yang semuanya bertanya adalah 50 Question, dan itu **bukan** 50 pesan.

- **In-app**: satu lencana dengan angka 50, daftar dikelompokkan per Run. Gratis, karena lencana adalah kueri.
- **Webhook**: pesan dikunci **(Run, jenis kejadian)** dengan jendela coalescing **60 detik**. Satu pesan: *"Run X: 50 pertanyaan menunggu group reviewer."*

Implementasinya satu baris `pending_notification` dengan `send_after`, dipungut oleh **sweep yang sudah ada di ticket 07**. Ini satu-satunya tabel notifikasi di sistem, dan ia hanya untuk pengiriman keluar — bukan untuk state lencana. Pemisahan itu yang menjaga sub-pertanyaan 6 tetap lunas: baris pengiriman boleh basi dan boleh dibuang, karena tidak ada yang membacanya untuk tahu apa yang masih menunggu.

Pesan yang sudah terkirim **tidak bisa ditarik**. Dinyatakan apa adanya: Question yang dijawab 30 detik setelah pesannya terkirim meninggalkan pesan yang sudah tidak berlaku di channel. Lencana sudah padam, dan tautan di pesan itu membawa ke Question yang terbaca "sudah dijawab oleh X". Itu cukup, dan mengejar pesan terkirim bukan pekerjaan yang layak dibayar.

### Konsekuensi ke ticket lain

- **14 (closed)** — janji "visibilitas menggantikan timer" dibayar oleh lencana-sebagai-kueri, halaman "Menunggu saya", dan penandaan umur. Nol kadaluarsa, nol pengingat per-Question; satu digest harian yang dibela terpisah.
- **05 (closed)** — pertanyaan *"apa yang menunggu saya"* jadi permukaan produk yang nyata, bukan cuma pernyataan model.
- **11 (closed)** — nol peran baru. Group ticket 08 yang menentukan siapa yang melihat, `admin` yang menyetel webhook.
- **22 (resolved)** — Run gagal masuk sebagai kejadian kedua justru karena Automation tidak punya manusia di belakangnya.
- **07 (closed)** — sweep dipakai ulang untuk pengiriman tertunda. Nol proses latar baru.
- **13 (open)** — daftar Run menandai tersumbat >24 jam; halaman Run menunjukkan cabang mana sumbatnya.
- **17 (open)** — sub-pertanyaan 4 ticket 17 ("orang menutup tab, kembali besok") sekarang punya jawabannya: yang ia lihat adalah halaman "Menunggu saya", dan jalur masuk ke sesi selalu dari sana.
