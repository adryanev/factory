# Packaging self-host

Type: grilling
Status: resolved
Assignee: adryanev
Blocked by: 25, 26

## Question

Premis map mengunci seluruh sistem harus bisa dijalankan sendiri oleh org, dan ticket 11 mempersempitnya: yang wajib self-hostable adalah **factory-nya**. Tiga ticket menaruh muatan di sini tanpa memutuskannya, dan ticket 15 menambah komponen keempat yang tidak ada saat premis itu ditulis.

Komponennya sekarang: control plane, web, Postgres, Garage, plus Runner yang justru **tidak** ikut compose karena ia hidup di mesin lain — termasuk mesin macOS yang tidak bisa disembunyikan di balik image kontainer.

1. **Bentuk compose, dan apakah Garage muat di dalamnya.** Ticket 15 memilih Garage karena `minio/minio` diarsipkan dan penerusnya berlisensi EULA proprietary. Garage punya cerita cluster dan layout sendiri; untuk deployment satu mesin, apakah ia satu servis polos di compose atau menuntut langkah inisialisasi layout yang operator harus jalankan sekali. Kalau menuntut, itu bukan lagi "docker compose up", dan itu harus dinyatakan sebagai bagian instalasi.

2. **Kapan migrasi berjalan.** Entrypoint control plane sebelum melayani, atau job terpisah yang operator jalankan. Yang membuat ini bukan kebiasaan: kalau operator menjalankan dua instance control plane (ticket 24 mengandaikannya — lease dengan lessee id instance), dua entrypoint berlomba menjalankan migrasi yang sama. Advisory lock, atau job terpisah yang menolak dua-duanya.

3. **Urutan upgrade, dan siapa yang boleh tua.** Ticket 07 mengunci versi protokol integer terpisah dari rilis, dan Runner basi tetap terlihat tapi tidak pernah dapat kerja. Jadi skew Runner sudah punya jawaban. Yang belum: skew antara control plane dan web (satu image atau dua), dan apakah migrasi DB harus mundur-kompatibel dengan control plane versi sebelumnya — kalau tidak, upgrade adalah pemadaman, dan itu boleh, tapi harus dinyatakan.

4. **Backup, dan satu hal yang tidak boleh ikut.** Postgres dan Garage keduanya memegang state yang tidak bisa dibangun ulang (ticket 20 mengunci baris biaya tidak pernah kedaluwarsa). Ticket 10 mengunci master key dari **file**, bukan env var, karena `/proc/self/environ` adalah vektor CVE-2025-66032 — dan file itu adalah satu-satunya hal yang membuat dump Postgres berguna bagi penyerang. Apakah ia sengaja dikeluarkan dari jalur backup yang sama, dan bagaimana operator diberitahu bahwa kehilangan file itu berarti kehilangan seluruh credential.

5. **Distribusi biner Runner.** Ticket 07 mengunci pembaruan manual (operator jalankan ulang installer) dan `latest_release` sudah ikut heartbeat. Sisanya di sini: bentuk artefak rilis (biner tunggal, tarball, image), platform yang didukung, cara verifikasi unduhan, dan cara operator **melihat** mesinnya ketinggalan — `latest_release` sampai ke Runner, tapi yang perlu tahu adalah manusia, dan halaman Runner di UI belum pernah diputuskan menampilkannya.

6. **Installer macOS, yang jauh lebih berat dari yang lain.** Ticket 10 mengunci agent berjalan sebagai user OS terpisah dari proses Runner — tanpa itu agent tinggal `cat runner.secret` dan naik jadi Runner. Maka installer harus membuat dua user OS (`_factory` dan `_factoryjob`), mengatur kepemilikan `runner.secret`, menyiapkan Xcode, dan mendaftarkan Runner sebagai layanan yang hidup setelah reboot. Yang diputuskan di sini: apakah ini skrip yang bisa dibaca sebelum dijalankan atau paket `.pkg`, dan apa yang terjadi kalau salah satu langkah gagal separuh jalan — instalasi separuh jadi yang menjalankan agent sebagai user yang salah adalah kegagalan **diam** yang membatalkan seluruh isolasi ticket 10.

7. **Konfigurasi.** Mana yang env var, mana yang file. Ticket 10 sudah memaksa master key jadi file; apakah aturan itu meluas ke seluruh secret di sisi control plane (kredensial DB, secret webhook GitHub ticket 22, kunci Garage) atau berhenti di master key saja. Aturan setengah-setengah butuh alasan yang bisa ditulis.

8. **Pemasangan pertama.** Membuat org, `owner` pertama, GitHub App (ticket 10 mengunci App installation token wajib — App-nya didaftarkan operator, dan itu langkah manual di UI GitHub dengan izin yang harus tepat), akun break-glass ticket 11, dan bucket Garage. Urutannya, dan mana yang otomatis.

9. **Apa yang dinyatakan tidak didukung.** Kubernetes, high availability, multi-region, TLS termination. Menyatakan batasnya di muka lebih murah daripada setengah mendukungnya.

Rekomendasi awal untuk diuji: satu compose untuk empat komponen dengan inisialisasi Garage sebagai langkah `install` sekali jalan, migrasi lewat advisory lock di entrypoint, satu image untuk control plane dan web, master key dinyatakan berada di luar backup dengan peringatan tertulis, installer macOS berupa skrip yang bisa dibaca dan **idempoten** supaya kegagalan separuh jalan bisa diulang, dan Kubernetes dinyatakan tidak didukung.

## Answer

Dua dari sembilan sub-pertanyaan **larut oleh fakta, bukan oleh keputusan**: Garage v2.3.0 menghapus langkah init yang jadi seluruh isi sub-pertanyaan 1, dan GitHub App manifest flow menghapus langkah manual yang jadi bagian terberat sub-pertanyaan 8. Sisanya diputuskan, dan satu tema mengikat hampir semuanya — **instalasi separuh jadi harus mustahil, bukan sekadar tidak dianjurkan**.

### 1. Garage adalah servis compose polos, dan versinya di-pin eksak

Premis ticket ("Garage punya cerita cluster dan layout sendiri, mungkin menuntut langkah operator") **kedaluwarsa**. [Garage v2.3.0](https://garagehq.deuxfleurs.fr/documentation/quick-start/) menambah `--single-node` yang membuat layout otomatis, plus `--default-bucket` dan `--default-access-key` yang membaca `GARAGE_DEFAULT_BUCKET`, `GARAGE_DEFAULT_ACCESS_KEY`, `GARAGE_DEFAULT_SECRET_KEY`. Maka:

- `garage server --single-node --default-bucket --default-access-key`, `GARAGE_DEFAULT_BUCKET=factory` — persis nama bucket ticket 15, jadi tiga prefix (`artifact/`, `log/`, `session/`) hidup tanpa satu perintah `garage` pun. `replication_factor: 1`, `db_engine: sqlite`, `rpc_secret` dibangkitkan saat init.
- Kredensial S3 **ditentukan sebelum Garage pertama kali hidup**, jadi control plane tidak pernah menunggu operator menyalin output `garage key create` ke sebuah file. Salin-tempel adalah tempat instalasi separuh jadi lahir; di sini ia tidak ada.
- Harganya: **versi Garage di-pin eksak**, pola yang sama dengan sandcastle di ticket 12 dan dengan alasan yang sama tajamnya — `garage:latest` yang ternyata < 2.3.0 naik dengan bucket yang tak pernah ada dan gagal di **upload pertama**, bukan saat boot. Yang di-pin bukan cuma versi tapi juga anggapan bahwa ketiga flag itu ada.

Alternatif yang ditolak: langkah `install` sekali jalan berisi `layout assign/apply` + `bucket create` + `key create`. Lebih portabel lintas versi dan outputnya terbaca, tapi ia mengubah instalasi dari satu perintah jadi prosedur dua fase dengan kredensial yang berpindah lewat tangan manusia.

### 2. Migrasi: servis one-shot, advisory lock, dan gerbang versi di boot

Diverifikasi di source Drizzle (`pg-core/dialect.ts`): `migrate()` **tidak mengambil lock apa pun** — ia membaca baris migrasi terakhir, lalu membungkus yang belum diterapkan dalam satu transaksi. Dua entrypoint yang berlomba sama-sama membaca "belum ada"; satu menang, satu mati dengan `relation already exists`. Ticket 24 mengandaikan dua instance control plane, jadi ini bukan kasus hipotetis.

Tiga bagian, dan **control plane bukan salah satunya**:

1. **Perintah `factory migrate` di image yang sama, dijalankan sebagai servis one-shot** dengan `depends_on: { condition: service_completed_successfully }` dari control plane. Jumlah migrator jadi satu **secara konstruksi**, dan migrasi yang gagal menahan control plane naik sama sekali — kegagalan terlihat sebagai container merah, bukan sebagai kueri aneh setengah jam kemudian.
2. **Perintah itu tetap mengambil `pg_advisory_lock`** meski compose sudah menjamin satu pemanggil. Sepuluh baris, dan ia menjaga jaminan tetap berlaku ketika operator mengetiknya dengan tangan selagi compose naik. Lock diambil **sebelum** `migrate()` dipanggil, supaya pemenang kedua membaca ulang daftar terapan dan jadi no-op alih-alih gagal.
3. **Control plane memeriksa hash migrasi terakhir saat boot dan menolak melayani kalau tidak cocok** dengan yang ikut di image. Tanpa ini, control plane baru di atas skema lama akan hidup, melayani, lalu patah di endpoint pertama yang menyentuh kolom baru — kegagalan diam, kelas yang sama dengan yang ditolak ticket 25 saat memilih trigger di atas REVOKE.

Alternatif yang ditolak: migrasi di entrypoint control plane dengan advisory lock. Ia menjaga "docker compose up" utuh tanpa servis tambahan, tapi migrasi yang gagal jadi crash-loop di **semua** instance sekaligus, log migrasi berbaur dengan log server, dan tidak ada satu tempat untuk melihat migrasi mana yang barusan jalan.

### 3. Satu image, dan upgrade adalah pemadaman singkat yang dinyatakan

**Web disajikan oleh control plane, satu image.** Web adalah bundle statis Vite; menyajikannya dari control plane menghapus **seluruh kelas skew web↔API secara struktural** — bundle yang dikirim selalu bundle yang cocok dengan API yang menyajikannya — sekaligus menghapus satu container, konfigurasi base URL API, dan seluruh urusan CORS. Paketnya tetap terpisah di monorepo; yang menyatu cuma artefak rilis.

Sisa skew yang tidak bisa dihapus: **tab browser yang sudah terbuka saat upgrade**. Penanganannya sengaja seringan mungkin — SPA membaca versi build dari respons yang sudah ia terima dan menampilkan **banner "muat ulang"**, tanpa penegakan apa pun. Menolak request dari bundle lama akan menuntut jalur error di setiap panggilan untuk masalah yang hilang dengan satu F5.

**Migrasi tidak dituntut mundur-kompatibel.** Gerbang versi di boot (keputusan 2) sudah berarti control plane lama menolak jalan di atas skema baru, jadi menuntut kompatibilitas mundur berarti membayar dua bentuk untuk setiap perubahan kolom demi menghemat belasan detik pada tim internal. Konsekuensinya dinyatakan telanjang: **upgrade adalah pemadaman**, panjangnya = durasi migrasi + restart.

Yang harus ikut dinyatakan karena tidak jelas dari situ:

- **StepRun `awaiting-human` kebal** — ia tidak punya lease (ticket 14), jadi pemadaman satu menit tidak menyentuhnya. Properti ini sudah dibayar di ticket 14; di sini ia baru terlihat harganya.
- **StepRun berjalan hanya aman kalau pemadaman lebih pendek dari lease Runner.** Runner yang gagal `/heartbeat` beberapa kali tetap sehat selama ia berhasil sekali sebelum lease habis; lewat dari itu, sweep memungutnya dan itu **memakan jatah `attempt`** (ticket 07). Maka aturan operasionalnya: upgrade yang diperkirakan melampaui satu window lease **didahului `desired_state: drain`** — mekanisme yang sudah ada di ticket 07, dipakai ulang, nol kode baru.
- **Migrasi mundur tidak ada.** Rollback = restore dari backup, sejalan dengan menerima pemadaman.

### 4. Backup: dua sasaran, dan satu file yang tidak boleh ikut secara struktural

Yang di-backup ada dua, dan keduanya punya cara yang benar berbeda:

- **Postgres lewat `pg_dump`** — konsisten transaksional, dan kecil karena byte tidak tinggal di sini (ticket 15).
- **Garage lewat sync S3 ke tujuan lain, bukan salin direktori data.** Alasannya bukan selera: menyalin direktori data servis yang hidup adalah snapshot yang tidak konsisten, sementara sync tingkat objek **aman di sini secara khusus** karena Artifact immutable (ticket 15) dan objek log tidak pernah ditulis ulang setelah selesai (ticket 18). Objek yang sedang ditulis akan terlewat, dan objek yang terlewat adalah log yang belum selesai dari Run yang sedang berjalan — kerugian yang benar untuk diterima.

**Master key sengaja berada di luar himpunan yang di-backup, dan itu ditegakkan lewat tata letak, bukan lewat peringatan.** Satu tarball yang memuat dump Postgres **dan** master key adalah seluruh credential tim dalam satu file — persis yang hendak dicegah enkripsi kolom ticket 10. Maka master key hidup di path yang **bukan** turunan dari direktori state mana pun (`/etc/factory/keys/master.key`, di-mount read-only), sehingga tidak ada perintah backup yang wajar yang bisa menyapunya diam-diam. Peringatan di README ditolak dengan alasan ticket 25: jaminan yang bergantung pada langkah operator adalah jaminan yang diam-diam tidak ada.

Yang harus dinyatakan supaya operator tahu taruhannya, dan yang ternyata **lebih kecil dari dugaan ticket**: kehilangan master key berarti **seluruh secret milik user harus dimasukkan ulang** — Run historis, baris biaya (ticket 20), dan audit log (ticket 11) tetap terbaca seluruhnya, karena tidak satu pun dari itu terenkripsi. Ini kehilangan yang menyakitkan, bukan kiamat, dan menyebutnya dengan tepat lebih berguna daripada menakuti operator.

**Tidak ada tooling backup yang dibangun.** Dua perintah standar di dokumentasi, dan satu aturan tata letak yang menegakkan bagian yang berbahaya. Membangun `factory backup` berarti memiliki jadwal, rotasi, dan cerita restore-nya sendiri untuk sesuatu yang `pg_dump` sudah selesaikan. RPO dinyatakan sebagai kebijakan operator, tidak dijanjikan sistem.

### 5. Runner didistribusikan sebagai tarball JS, bukan biner tunggal

**Bentuk artefak: tarball berisi bundle JS + `package.json`, dengan Node ≥22 sebagai prasyarat.** Platform: `linux-x64`, `linux-arm64`, `darwin-arm64`.

Yang memutuskan ini bukan kemudahan build, melainkan **notarisasi Apple**: biner tunggal yang diunduh di macOS kena quarantine dan Gatekeeper menolaknya kecuali ditandatangani Developer ID dan dinotarisasi — biaya tahunan plus alur Apple, untuk mesin yang **sudah** wajib punya Xcode terpasang (ticket 10). Menuntut Node di mesin yang sudah menuntut Xcode adalah tambahan nol. Dan `bun build --compile` / Node SEA menambah toolchain eksotis di jalur rilis untuk menghapus prasyarat yang tidak menyakitkan siapa pun.

Runner **tidak** didistribusikan sebagai image kontainer. Untuk `exec:docker`, Runner di dalam kontainer menuntut socket Docker host di-mount — yang setara root di mesin itu, dan mengubah seluruh perhitungan isolasi ticket 10 tanpa memberi apa pun sebagai gantinya.

**Verifikasi unduhan: SHA-256 di rilis GitHub yang sama, dan itu dinyatakan apa adanya** — checksum yang diterbitkan bersama artefaknya mendeteksi **unduhan rusak, bukan penyerang**; yang dipercaya adalah HTTPS dan akun rilis GitHub. Penandatanganan (cosign/minisign) ditolak sekarang karena ia menuntut cerita manajemen kunci penandatangan yang belum ada, dan tanda tangan dengan kunci yang disimpan sembarangan cuma memindahkan kepercayaan sambil terlihat lebih aman.

**Yang perlu tahu Runner ketinggalan adalah manusia**: halaman Runner di UI menampilkan versi tiap Runner, heartbeat terakhir, dan menandai yang di bawah `latest_release`. `latest_release` yang sudah ikut heartbeat (ticket 07) tetap ada, tapi ia menggerakkan tampilan, bukan pembaruan otomatis. Notifikasi untuk Runner usang tidak dibangun — sejalan dengan kabut "notifikasi Runner offline" yang sudah tercatat.

### 6. Installer macOS: skrip yang bisa dibaca, dan verifikasi isolasi sebagai gerbang identitas

**Skrip shell yang diunduh dulu lalu dijalankan** (bukan `curl | sh`), idempoten. `.pkg` ditolak: ia menuntut Developer ID + notarisasi yang sama dengan biner tunggal, dan isinya **tidak bisa dibaca sebelum dijalankan** — untuk sesuatu yang membuat dua user OS dan sebuah daemon root, "bisa dibaca sebelum dijalankan" bernilai lebih dari klik dua kali.

Yang ia lakukan: membuat `_factory` dan `_factoryjob`, menulis `runner.secret` 0600 milik `_factory`, memasang `launchd` daemon berjalan sebagai `_factory` dengan `KeepAlive` supaya hidup setelah reboot. **Xcode tidak dipasang installer** — ia memverifikasi `xcode-select -p` dan lisensi sudah disetujui, lalu berhenti dengan instruksi; memasang Xcode menuntut Apple ID, yang di luar wewenang sebuah skrip.

Keputusan paling tajam di sini menjawab "apa yang terjadi kalau gagal separuh jalan": **verifikasi isolasi adalah gerbang menuju identitas.** Langkah terakhir skrip menjalankan pos-kondisi — dua user ada, kepemilikan dan mode `runner.secret` benar, daemon jalan, dan `sudo -u _factoryjob cat runner.secret` **harus gagal** — dan **penukaran join token baru terjadi setelah semuanya hijau**. Konsekuensinya: instalasi separuh jadi menghasilkan mesin yang **tidak pernah punya identitas**, jadi ia tidak pernah muncul di kolam dan tidak pernah dapat kerja. Kegagalan diam yang ditakuti ticket 10 — agent berjalan sebagai user yang salah dan seluruh isolasi batal — jadi mustahil dicapai lewat instalasi yang gagal, karena Runner yang tidak terverifikasi tidak punya cara untuk meminta pekerjaan.

Installer Linux adalah skrip serupa dengan systemd unit, **tapi user OS kedua hanya untuk host mode**: di `exec:docker` agent hidup di kontainer dan tidak pernah berbagi filesystem dengan proses Runner, jadi vektor `cat runner.secret` sudah tertutup isolasi kontainer.

### 7. Konfigurasi: bahan kunci ke file, password layanan ke env var

Alasan ticket 10 dibaca ulang dan **dipersempit supaya jujur**: vektornya adalah agent yang dibujuk membaca `/proc/self/environ` — tapi agent **tidak pernah berjalan di host control plane**, ia berjalan di Sandbox di Runner. Di control plane, aturan file bukan penangkal CVE-2025-66032; ia pertahanan berlapis terhadap `docker inspect`, core dump, dan env yang diwarisi child process. Mengarang alasan yang salah akan melahirkan aturan turunan yang salah.

Garisnya: **bahan kunci kriptografis ke file, password layanan ke env var.**

- **File** (path ditunjuk env var, mount lewat `secrets:` compose): **master key** dan **private key GitHub App**. Yang pertama membuat dump Postgres terbaca; yang kedua membuat siapa pun bisa mencetak installation token atas nama factory. Private key juga PEM multi-baris — env var memang tempat yang salah untuknya secara mekanis.
- **Env var**: password Postgres, webhook secret GitHub, access key + secret Garage. Ketiganya kredensial ke layanan di compose yang sama, hanya berguna selama layanan itu terjangkau, dan bisa dirotasi dengan satu restart tanpa kehilangan data.

Titik terlemahnya dinyatakan telanjang: **access key Garage yang bocor berarti seluruh Artifact, log, dan session bisa dibaca.** Yang membuatnya tetap di env adalah bahwa ia tidak menambah apa pun di atas password Postgres yang juga di sana — env control plane yang bocor sudah berarti seluruh isi DB. Satu-satunya yang tetap terkunci adalah nilai secret milik user, dan itu persis yang dijaga master key di file.

Aturan seragam "semua secret ke file" ditolak dengan harga yang bisa ditunjuk: Garage tidak mengenal konvensi `*_FILE`, jadi menegakkannya berarti membuang `--default-access-key` dan mengembalikan langkah init yang baru saja dihapus keputusan 1.

### 8. Pemasangan pertama: satu perintah init, lalu manifest flow

Sub-pertanyaan ini mengandaikan pendaftaran GitHub App adalah "langkah manual di UI GitHub dengan izin yang harus tepat". [Manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest) menghapusnya: kita POST manifest JSON berisi izin yang **kita** tentukan, operator cuma menekan Create, GitHub redirect balik dengan `code`, dan `POST /app-manifests/{code}/conversions` mengembalikan **app id, private key PEM, dan webhook secret** sekaligus. Seluruh kelas "izin salah dicentang" lenyap, dan private key mendarat langsung di file tanpa pernah lewat clipboard.

Urutannya:

1. **`factory init`** membangkitkan seluruh rahasia lokal — master key (file 0600 di luar direktori state), `rpc_secret` Garage, access key + secret Garage, password Postgres — lalu menulis `.env` dan mencetak password akun break-glass ticket 11 **sekali ke stdout**. Nol nilai default yang dikirim; tidak ada `changeme` yang bisa bertahan sampai produksi.
2. **`docker compose up -d`** → job migrate → control plane. Bucket Garage lahir sendiri, jadi nol langkah.
3. **Halaman setup di UI** mem-POST manifest ke GitHub dan menerima redirect-nya. Redirect ditujukan ke browser operator, jadi **ini bekerja di `http://localhost` sebelum ada URL publik atau TLS**; yang butuh URL publik cuma `hook_attributes.url` di manifest, yang operator isi di halaman itu dan bisa diubah belakangan. Batas satu jam untuk menyelesaikan ketiga langkah dinyatakan di halaman.
4. **User GitHub pertama yang login setelah itu diangkat `owner`**, lalu pintu ditutup permanen (`bootstrap_completed_at`). Tidak ada kredensial admin default yang pernah ada untuk ditebak.

Webhook secret jadi dibangkitkan GitHub, bukan `factory init` — koreksi kecil terhadap langkah 1 yang muncul dari manifest flow.

### 9. Yang dinyatakan tidak didukung

- **Kubernetes / Helm chart.** Compose adalah satu-satunya bentuk deployment yang diuji.
- **High availability.** Dua instance control plane **berjalan benar secara mekanis** — lease ticket 24 sudah menanganinya — tapi tidak ada load balancer, dokumentasi, atau uji untuk itu. "Tidak didukung", bukan "tidak mungkin"; bedanya penting supaya tidak ada yang membangun di atasnya diam-diam.
- **Postgres HA, Garage multi-node, multi-region.** `replication_factor: 1` adalah keputusan, bukan default yang tertinggal.
- **TLS termination di dalam compose.** Operator menaruh reverse proxy di depan; memilikinya di dalam berarti memiliki cerita ACME, pembaruan sertifikat, dan DNS. **HTTPS tetap wajib untuk endpoint webhook** — payload memuat nama repo privat dan HMAC-nya lewat header — jadi dokumentasi memuat satu contoh Caddy sebagai jalur terpendek, bukan sebagai komponen.
- **Postgres atau Garage terkelola di luar compose.** Cuma env var, jadi ia akan bekerja; tidak diuji dan tidak dijanjikan.
- **Runner Windows.** Tidak ada.
- **Rollback migrasi.** Maju saja; mundur = restore dari backup.

### Catatan pengambilan keputusan

Sub-pertanyaan **1, 2, dan 7 diadu dengan user** dan disetujui. Sub-pertanyaan **3, 4, 5, 6, 8, dan 9 diambil agent sendirian** atas permintaan user — belum dibantah siapa pun. Yang paling layak diadu ulang: **satu image untuk web dan control plane** (ia mengunci web tidak pernah bisa di-deploy sendiri), dan **prasyarat Node di Runner** (ia memindahkan beban ke operator tiap mesin baru).
