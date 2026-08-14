# Prototype: layar grilling session di web

Type: prototype
Status: resolved
Blocked by: 14, 15

## Question

Menyusun product requirement lewat grilling session di dalam web itu rasanya seperti apa — dan apakah bentuknya masih masuk akal ketika percakapan sudah panjang dan draf sudah berubah tujuh kali?

Ini layar tersulit di seluruh produk: percakapan dan artefak yang sedang tumbuh harus hidup berdampingan di satu layar. Diskusi tidak akan menyelesaikannya; bikin sesuatu yang bisa direaksi.

Bangun prototype sekali pakai (React + Vite, data palsu, tanpa backend) untuk satu sesi grilling penyusunan PRD yang sudah berjalan — sekitar 15 giliran, dengan draf PRD yang sudah tiga kali direvisi.

Yang harus dijawab lewat prototype:

1. **Tata letak** — percakapan dan draf berdampingan, bertumpuk, atau bergantian? Draf yang tumbuh sambil dibicarakan adalah inti fiturnya; kalau ia tersembunyi di balik tab, fiturnya kehilangan maksud.
2. **Bentuk giliran** — grilling mengajukan satu pertanyaan pada satu waktu. Apakah jawabannya teks bebas, pilihan yang direkomendasikan agent, atau keduanya? Bandingkan dengan cara `/grilling` bekerja di terminal.
3. **Manusia menyunting draf** — bisakah orang mengubah draf langsung, bukan hanya lewat percakapan? Kalau ya, bagaimana agent diberi tahu, dan bagaimana suntingan manusia dibedakan dari tulisan agent.
4. **Menunggu** — orang menutup tab, kembali besok. Apa yang ia lihat saat membuka lagi. Bagaimana ia tahu ada sesi yang menunggu dia. Ini keadaan yang paling sering terjadi, bukan kasus pinggiran.
5. **Percakapan panjang** — 80 giliran. Bagaimana orang menemukan lagi keputusan yang diambil di giliran ke-12. Adakah ringkasan keputusan yang terpisah dari transkrip?
6. **Selesai** — apa yang menandai sesi berakhir, dan apa yang terjadi setelahnya: PRD jadi artefak, run lanjut ke step berikutnya. Tombolnya seperti apa dan siapa yang menekan.
7. **Sesi yang salah arah** — bagaimana orang mundur, mengulang dari giliran tertentu, atau membuang sesi.

Simpan di `docs/design/distributed-software-factory/prototypes/grilling-ui/` dan tautkan dari sini. Sekali pakai — yang diambil keputusannya, bukan kodenya.

**Bahan dari ticket 15**: draf PRD adalah Artifact `kind: document` dengan `key: "prd"`, **immutable dan satu per StepRun** — jadi "draf yang sudah tiga kali direvisi" berarti tiga baris Artifact di tiga StepRun berbeda, bukan satu dokumen yang berubah. Pertanyaan 3 dan 5 harus dirancang di atas bentuk itu: riwayat sudah tersedia gratis sebagai urutan turn, dan `edit-artifact` sebagai `kind` Question keempat sekarang boleh dipakai tanpa keputusan baru. Renderer draf adalah markdown, transkrip juga dirender sebagai markdown.

**Tugas tambahan dari ticket 14 yang masih berlaku**: ukur biaya setup per giliran (start container + fetch branch + unduh session + cold start agent) — angka itu yang dibutuhkan untuk membuka kembali kabut *ambang tahan-sandbox*.

---

**Prototype ada**: [`prototypes/grilling-ui/index.html`](../prototypes/grilling-ui/index.html) — satu berkas, tanpa build, tanpa dependency. Buka langsung di browser.

Menyimpang dari "React + Vite" dengan alasan yang sama seperti ticket 13: harus bisa dibuka tanpa `pnpm install`, dan yang diambil adalah keputusannya.

**Tugas tambahan tidak bisa dijalankan lewat prototype ini.** Biaya setup per giliran menuntut pengukuran di Runner sungguhan — start container, fetch branch, unduh session dari Garage, cold start agent — dan data palsu tidak menghasilkan angka. Ia perlu ticket `task` tersendiri setelah ada satu Runner terpasang; sampai itu ada, kabut *ambang tahan-sandbox* tetap kabut dan angka 30–60 detik tetap tebakan.

## Answer

**Tujuh sakelar hidup, tujuh keputusan diambil sambil melihat** — pola yang ticket 13 buktikan, dipakai lagi di sini karena ketujuh pertanyaan ticket ini adalah pertanyaan tentang bentuk, bukan tentang mekanisme. Prototype dimuat pada kombinasi yang dipilih; varian yang ditolak tetap bisa dinyalakan untuk melihat apa yang hilang.

**Sebelum itu: bahasa visualnya berganti.** Palet biru-gelap prototype 13 diganti **token Corpus** dari `~/Code/lexicon/frontend/packages/design-system` — primary teal (`#009689` terang / `#2fe0e1` gelap), skala neutral Primer, `--radius: 0.875rem`, skala bayangan dan tipografi Figma, light **dan** dark. Ini bukan selera: itu design system yang sudah ada implementasinya, dan factory tidak perlu bahasa visual kedua. Rethink Sans dipakai untuk heading dengan fallback ke system stack. Konsekuensinya prototype 13 sekarang memakai palet yang usang — bukan cacat yang perlu diperbaiki (ia sudah resolved dan keputusannya soal bentuk, bukan warna), tapi surface produk berikutnya mengikuti Corpus, bukan prototype 13.

**1 — Tata letak: berdampingan.** Percakapan dan draf keduanya penuh. Draf yang tumbuh sambil dibicarakan adalah inti fiturnya, jadi setiap tata letak yang mengurangi salah satunya membayar langsung ke fitur itu. *Draf dominan* menyempitkan percakapan jadi kolom kurus; *bertumpuk* menjaga keduanya terlihat dengan memotong tinggi masing-masing; *bergantian* menyembunyikan salah satunya dan di situ fiturnya kehilangan maksud. Harga yang diterima sadar: di bawah 1080px dua kolom jadi bertumpuk, dan di mobile jadi bergantian — jadi bentuk yang ditolak untuk desktop justru jadi satu-satunya bentuk yang muat di ponsel.

**2 — Bentuk giliran: pilihan + teks, teks tidak pernah hilang.** Agent boleh menawarkan pilihan bernomor; kotak teks bebas selalu ada di bawahnya. Ini yang menjaga janji `/grilling` di terminal, yang tidak pernah membatasi jawaban. *Pilihan saja* dibangun justru supaya bisa ditolak sambil melihat: matikan kotak teksnya, lalu perhatikan bahwa jawaban “ya, tapi hanya untuk order di atas 50 juta” tidak punya tempat untuk ditulis. Konsekuensi ke ticket 14: tiga `kind` tertutup tetap benar, dan `choice` berarti *choice dengan teks*, bukan *choice sebagai gantinya teks* — Question `choice` tetap menerima `text` sebagai jawaban sah.

**3 — Suntingan manusia: sunting langsung di draf.** Orang mengubah draf di tempat; hasilnya **Artifact baru milik StepRun giliran berikutnya**, dan agent diberi tahu lewat **pertanyaan di giliran setelahnya**, bukan notifikasi diam. Ini murah **karena** ticket 15: Artifact immutable satu per StepRun berarti riwayat sudah gratis dan tidak ada tabel versi yang perlu dibuat, dan `edit-artifact` sebagai `kind` keempat memang sudah dibuka tanpa keputusan baru. *Usul, agent yang menerapkan* ditolak dengan harga yang bisa dihitung: satu putaran Runner penuh — lima langkah setup — sebelum kamu melihat kalimat yang baru saja kamu ketik. *Hanya lewat percakapan* ditolak karena mengoreksi satu kalimat jadi menuntut satu giliran penuh. Tanda penulis manusia adalah warna `--attention`, dan ia sengaja **hanya** dipakai untuk itu: gelembung jawaban manusia biasa memakai surface netral, supaya ungu berarti *ditulis manusia ke dalam artefak*, bukan sekadar *bukan agent*.

**4 — Kembali besok: ringkasan “Selagi kamu pergi”, bukan banner umur.** Yang dibawa orang saat membuka lagi bukan “sudah berapa lama menggantung” — umur itu sudah ia lewati satu layar sebelumnya di halaman *Menunggu saya* ticket 19 — melainkan **apa yang berubah sejak kemarin**. Ringkasannya empat angka: revisi draf, suntingan manusia, keputusan tercatat, pertanyaan terbuka. Keempatnya **kueri atas state yang sudah ada**, jadi janji ticket 19 tetap dibayar harfiah: tidak ada baris baru yang ditulis, tidak ada yang bisa basi, dan dijawab orang lain berarti ringkasannya berubah sendiri. *Tanpa penanda* dibangun untuk ditolak sambil melihat, dan hasilnya jelas: mendarat di transkrip giliran 80 tanpa penanda berarti menggulir untuk mencari tahu apakah ada yang perlu dibaca ulang.

**5 — Menemukan lagi: tab Keputusan.** Daftar keputusan berbagi panel dengan draf. *Rel tetap* ditolak bukan karena tidak berguna tapi karena harganya salah alamat: ia memotong ~15rem dari lebar, dan yang dipotong adalah draf — satu-satunya hal yang keputusan 1 baru saja bayar mahal untuk dijaga tetap lebar. *Gulir + cari* ditolak setelah dicoba pada 80 giliran: pencarian teks menemukan **giliran yang menyebut** sebuah kata, bukan **keputusan yang diambil** tentangnya, dan keduanya tidak sama. Yang ikut terkunci: daftar keputusan **dibangkitkan agent tiap giliran sebagai bagian Output**, bukan fitur UI dan bukan ringkasan yang ditulis ulang manusia — artinya skema Output Step interaktif ticket 23 bertambah satu bidang, dan itu satu-satunya keputusan di ticket ini yang menyentuh definisi Pipeline.

**Temuan sampingan yang dipakai: giliran dilipat, bukan dihilangkan.** Transkrip menampilkan rentang giliran yang tidak membawa keputusan sebagai satu baris `giliran 6–7 dilipat`, bisa dibuka. Ini lahir dari cacat prototype (nomor giliran melompat) tapi jawabannya benar untuk produk: pada 80 giliran, melipat yang tidak membawa keputusan adalah cara ketiga menemukan lagi, di samping tab Keputusan dan pencarian.

**6 — Selesai: jawaban atas giliran terakhir, tanpa tombol tersendiri.** Agent bertanya “sudah cukup?”, orang menjawab, Step berakhir, Artifact `prd` final, Graph lanjut. Nol permukaan baru. *Tombol Selesaikan sesi* ditolak dengan bukti yang terlihat di layar: ia mendarat di bilah atas persis bersebelahan dengan **Batalkan Run** — susunan tombol destruktif berdampingan dengan tombol utama yang ticket 13 tolak eksplisit. *Question `approval`* ditolak karena menambah satu `kind` untuk satu kejadian per sesi, sementara `choice` sudah menyampaikan hal yang sama; ini juga menjaga tiga `kind` ticket 14 tetap tiga.

**7 — Salah arah: Batalkan Run **plus** rewind per giliran.** Ticket 14 menyimpan bahan rewind gratis dan menunda tombolnya; ticket 06 sudah mengunci bentuknya — **Run baru dengan `parent_run_id`**, bukan penghapusan. Yang tersisa memang cuma memasang tombolnya, dan sekarang dipasang: kontrol “Ulang dari sini” muncul per giliran saat kursor lewat, dan konfirmasinya menyatakan terang bahwa Run lama beserta seluruh Artifact-nya tetap ada. *Buang sesi* ditolak — aksi destruktif ketiga di sebelah transkrip yang sedang dibaca, sementara Batalkan Run sudah melakukan persis hal itu. Ini **melunasi “rewind ditunda tapi laten” dari ticket 14** tanpa satu pun keputusan model data baru.

**Yang prototype ini gagal jawab, dan kenapa kegagalannya berguna.** Tugas tambahan dari ticket 14 — ukur biaya setup per giliran — **tidak bisa dijawab prototype apa pun**, dan itu bukan kekurangan prototype ini melainkan salah alamatnya pemicu yang ditulis di kabut. Yang bisa diberikan prototype cuma **bentuknya**: lima langkah berurutan (jadwalkan StepRun → start container + network → fetch branch → unduh session dari Garage → cold start agent) yang terlihat di layar setiap kali seseorang menekan Kirim jawaban, dengan kotak jawaban tertutup selama itu. Bentuk itu sendiri sudah cukup untuk satu kesimpulan: **biayanya dibayar di depan mata penjawab, bukan di latar belakang**, jadi ambang tahan-sandbox adalah pertanyaan tentang pengalaman penjawab cepat, bukan tentang efisiensi Runner. Angkanya tetap butuh Runner terpasang, dan Runner terpasang ada **setelah** destination map ini — karena itu kabut *ambang tahan-sandbox* dipindahkan ke **Out of scope**, bukan digantung dengan pemicu yang map ini tidak akan pernah bisa nyalakan.

**Tidak divariasikan dengan sengaja**: kepadatan informasi, penempatan tombol destruktif, dan notasi giliran — ketiganya sudah dikunci ticket 13 dan bukan selera. Notasi panjang (`giliran 4 · attempt 1`) dipakai apa adanya.

**Belum terverifikasi**: tampilan mobile. Aturan responsifnya ditulis (panel bertumpuk di bawah 1080px, label bilah atas disembunyikan di bawah 720px, bilah keputusan satu kolom di bawah 640px) tapi tidak pernah dilihat — jendela browser di sesi ini menolak mengecil di bawah ~1400px.
