# Atribusi Commit dan Grafik Kontribusi GitHub, Terutama Saat Squash Merge

Status: SELESAI. Menjawab tiket #137.

**Vonis di depan:** premis "author = Principal pemicu Run, committer = `factory[bot]`"
**gugur di bawah squash merge**. GitHub menetapkan author commit hasil squash ke
**pembuka pull request**, dan di desain ini PR dibuka oleh GitHub App. Yang selamat
adalah trailer `Co-authored-by:` — GitHub **menambahkannya sendiri** dari author
commit di cabang, tanpa izin baru dan tanpa perubahan kode. Rebase merge dan merge
commit biasa mempertahankan author manusia utuh.

Setiap klaim ditandai:
- **[VERIFIED-DOC]** — dari dokumentasi resmi GitHub yang dibaca langsung (URL disebut).
- **[VERIFIED-EMPIRIS]** — dari data repo publik lewat GitHub REST API, dicek sendiri.
- **[INFERENSI]** — kesimpulan saya dari fakta di atas, bukan pernyataan eksplisit dokumentasi.

---

## 1. Syarat sebuah commit dihitung ke grafik kontribusi

Sumber utama: [Profile contributions reference](https://docs.github.com/en/account-and-profile/reference/profile-contributions-reference).

**[VERIFIED-DOC]** "Commits will appear on your contributions graph if they meet
**all** of the following conditions":

1. "The email address used to make the commits is associated with your account on GitHub."
2. "The commits were made in a standalone repository, not a fork."
3. "The commits were made in one of two branches: The repository's default branch [atau] the `gh-pages` branch."

**[VERIFIED-DOC]** Dan **setidaknya satu** dari ini harus benar:

- "You are a collaborator on the repository or are a member of the organization that owns the repository."
- "You have forked the repository."
- "You have opened a pull request or issue in the repository."

Catatan penting untuk desain kita: kalau PR dibuka oleh App, manusia **tidak**
memenuhi butir ketiga lewat PR itu. Ia harus collaborator repo atau member org
pemilik repo. Untuk repo `product` milik org tim, syarat ini normalnya terpenuhi;
untuk repo di luar org, ia tidak otomatis terpenuhi.

### Bentuk email `noreply`

**[VERIFIED-DOC]** [Email addresses reference](https://docs.github.com/en/account-and-profile/reference/email-addresses-reference):
"If you created your account _after_ July 18, 2017, your `noreply` email address is
an ID number and your username in the form of `ID+USERNAME@users.noreply.github.com`."
Bentuk lama `USERNAME@users.noreply.github.com` hanya untuk akun sebelum tanggal itu.

**[VERIFIED-DOC]** Bentuk ID-based tahan ganti username: "If you use your `noreply`
email address ... to make commits and then change your username, those commits will
not be associated with your account. This does not apply if you're using the ID-based
`noreply` address."

Artinya rencana memakai `<id>+<username>@users.noreply.github.com` **benar** dan
lebih tahan banting daripada email pribadi — asal ID-nya benar, bukan cuma username.

### Waktu yang dipakai grafik

**[VERIFIED-DOC]** "On your profile page, the author date is used to calculate when
a commit was made. Whereas, in a repository, the commit date is used." Grafik
memakai **author date**, bukan commit date.

**[VERIFIED-DOC]** Butuh jeda: "you may need to wait for up to 24 hours to see the
contribution appear on your contributions graph"
([Why are my contributions not showing up](https://docs.github.com/en/account-and-profile/setting-up-and-managing-your-github-profile/managing-contribution-settings-on-your-profile/why-are-my-contributions-not-showing-up-on-my-profile)).

---

## 2. Yang menentukan: apa yang terjadi pada author saat PR di-merge

### 2.1 Squash merge — author jatuh ke pembuka PR

Ini titik gugurnya premis. Tiga bukti independen, satu di antaranya empiris.

**[VERIFIED-DOC] Bukti 1 — dokumentasi menyebutnya eksplisit.**
[Merging a pull request (GHES 3.17)](https://docs.github.com/en/enterprise-server@3.17/pull-requests/how-tos/merge-and-close-pull-requests/merging-a-pull-request):

> "The email selector is not available for rebase merges, which do not create a merge
> commit, **or for squash merges, which credit the user who created the pull request
> as the author of the squashed commit**."

Kalimat ini di-render pada seluruh versi GitHub Enterprise Server. Pada github.com
(fpt/ghec) potongan yang sama diganti oleh varian fitur `squash-merge-email` menjadi:

> "For squash merges, the email selector is only shown if you are the pull request
> author and you have more than one email address associated with your account."

([Merging a pull request, versi github.com](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/merging-a-pull-request))

**[INFERENSI]** Varian github.com tidak mencabut aturannya, ia mengonfirmasinya:
pemilihan email author hanya masuk akal ditawarkan kepada pembuka PR justru karena
pembuka PR-lah yang jadi author. Sumber percabangan ini ada di source dokumentasi,
`content/pull-requests/how-tos/merge-and-close-pull-requests/merging-a-pull-request.md`
di repo `github/docs`, dengan flag `data/features/squash-merge-email.yml` yang hanya
memuat `fpt` dan `ghec`.

**[VERIFIED-DOC] Bukti 2 — changelog yang memperkenalkan co-author pada squash.**
[Improved attribution when squashing commits (19 Des 2019)](https://github.blog/changelog/2019-12-19-improved-attribution-when-squashing-commits/):

> "whoever opened the pull request became the sole author of the squash commit"

lalu perubahannya: GitHub kini "automatically credit _every_ commit author in the
pull request as a co-author on the squash commit." Perubahan itu **menambah trailer
co-author**; ia tidak memindahkan field author.

**[VERIFIED-EMPIRIS] Bukti 3 — kasus yang persis sama dengan desain kita.**
Repo `aio-libs/aiohttp`, PR backport yang **dibuka oleh GitHub App** `patchback[bot]`
sementara seluruh commit di cabang di-author oleh manusia (Sam Bull / `Dreamsorcerer`),
lalu di-squash merge. Diambil lewat REST API:

| PR | Pembuka PR | Author commit di cabang | Author commit hasil | Committer hasil |
| --- | --- | --- | --- | --- |
| [#13392](https://github.com/aio-libs/aiohttp/pull/13392) | `patchback[bot]` | `Sam Bull <git@sambull.org>` (2 commit) | `patchback[bot] <45432694+patchback[bot]@users.noreply.github.com>` | `GitHub <noreply@github.com>` (`web-flow`) |
| [#13391](https://github.com/aio-libs/aiohttp/pull/13391) | `patchback[bot]` | `Sam Bull` (2 commit) | `patchback[bot]` | `GitHub` (`web-flow`) |
| [#13390](https://github.com/aio-libs/aiohttp/pull/13390) | `patchback[bot]` | `Sam Bull` (1 commit) | `patchback[bot]` | `GitHub` (`web-flow`) |

Ketiga commit hasil punya satu parent (fast-forward, ciri squash) dan pesan berakhir
`(#NNNNN)`. Ketiganya memuat baris `Co-authored-by: Sam Bull <git@sambull.org>` yang
**ditambahkan GitHub sendiri**, termasuk pada #13390 yang cabangnya hanya berisi satu
commit dari satu author. Ketiganya `verified: true` — GitHub menandatangani commit
squash yang ia buat.

**[VERIFIED-EMPIRIS] Kasus kedua, sekaligus menguji setelan pesan squash.**
[microsandbox/microsandbox#78](https://github.com/microsandbox/microsandbox/pull/78):
PR dibuka `github-actions[bot]`, di-merge oleh manusia (`appcypher`), squash ke `main`.
Author commit hasil = `github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>`
— **pembuka PR, bukan yang menekan tombol merge**. Ini mematikan hipotesis ketiga
("author = yang menekan merge"). Pesan commit hasilnya hanya judul + trailer:

```
chore: release main (#78)

Co-authored-by: github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>
```

Padahal body PR-nya 1376 karakter (changelog release-please) dan tidak ikut masuk —
artinya repo itu mengonfigurasi pesan squash tanpa body, **dan trailer tetap
ditambahkan**. Lihat §Gap 1 untuk batas kesimpulan ini.

**Kesimpulan:** kalau PR dibuka `factory[bot]`, author commit di default branch
adalah `factory[bot]`, apa pun yang kita tulis di dalam Sandbox. Atribusi manusia
hanya selamat lewat trailer.

### 2.2 Rebase merge — author manusia selamat

**[VERIFIED-DOC]** [Pull request merges](https://docs.github.com/en/pull-requests/reference/pull-request-merges):
"all commits from the topic branch (or head branch) are added onto the base branch
individually without a merge commit." Yang berubah hanya committer: rebase and merge
di GitHub "Always updates the committer information and creates new commit SHAs,
whereas `git rebase` does not change the committer information when the rebase happens
on top of an ancestor commit."

**[VERIFIED-DOC]** Dan kredit kontribusinya eksplisit di
[Profile contributions reference](https://docs.github.com/en/account-and-profile/reference/profile-contributions-reference):
"When rebasing commits, the original authors of the commit and the person who rebased
the commits ... receive contribution credit."

**[VERIFIED-DOC]** Harga yang dibayar: signature hilang. "the commits in the head
branch are added to the base branch **without commit signature verification** ...
GitHub doesn't have access to the committer's private signing keys, so it can't sign
the commit on the user's behalf."

### 2.3 Merge commit — author manusia selamat

**[VERIFIED-DOC]** "all commits from the feature branch are added to the base branch
in a merge commit. The pull request is merged using the `--no-ff` option"
([Pull request merges](https://docs.github.com/en/pull-requests/reference/pull-request-merges)).
Commit asli masuk apa adanya ke default branch, author-nya tidak disentuh; hanya
merge commit tambahan yang author-nya orang/aktor yang menekan merge.

### 2.4 Ringkas

| Metode | Author commit manusia sampai default branch? | Catatan |
| --- | --- | --- |
| Squash and merge | **Tidak.** Author = pembuka PR (= App) | Manusia turun jadi `Co-authored-by:` |
| Rebase and merge | Ya | Committer ditulis ulang, signature hilang |
| Merge commit | Ya | Riwayat cabang ikut masuk |

---

## 3. `Co-authored-by:` sebagai jalur atribusi

**[VERIFIED-DOC]** Trailer dihitung ke grafik. Syaratnya sama dengan commit biasa:
[Creating a commit with multiple authors](https://docs.github.com/en/pull-requests/how-tos/commit-changes/creating-a-commit-with-multiple-authors)
— "For the commit to count as a contribution, use an email address associated with
their account on GitHub.com." dan "If a co-author keeps their email address private,
use their GitHub-provided `no-reply` email."

**[VERIFIED-DOC]** Pernyataan paling tegas ada di halaman GHES
[Profile contributions reference (GHES 3.17)](https://docs.github.com/en/enterprise-server@3.17/account-and-profile/reference/profile-contributions-reference):
kriteria email berbunyi "The email address used to make **or co-author** the commits
is associated with your account", dan ada kalimat terpisah: "To appear on your profile
contributions graph, co-authored commits must meet the same criteria as commits with
one author." Pada versi github.com dua potongan itu disembunyikan oleh
kondisi `{% ifversion ghes %}`, jadi halaman fpt/ghec **tidak** menyebut co-author
secara eksplisit. Aturannya sama; yang berbeda hanya kelengkapan teks halaman.

**[VERIFIED-DOC]** Bentuk trailer: satu baris `Co-authored-by: NAME <NAME@EXAMPLE.COM>`
per co-author, ditaruh **setelah baris kosong** di akhir pesan commit, boleh lebih
dari satu.

**[VERIFIED-EMPIRIS]** Trailer **bertahan melewati squash merge**, dan lebih dari itu:
GitHub yang menambahkannya, diambil dari author commit di cabang — lihat tabel di
§2.1. Kita tidak perlu menulis trailer sendiri agar manusia muncul di sana; cukup
author commit di dalam Sandbox sudah benar.

**Konsekuensi untuk desain:** premis "atribusi harus disetel di dalam Sandbox" tetap
benar, hanya efeknya bergeser. `git config user.email` = noreply manusia di dalam
Sandbox tetap wajib — bukan supaya jadi author di default branch, tapi supaya GitHub
punya bahan untuk menulis `Co-authored-by:` saat squash. Tidak ada izin baru, tidak
ada perubahan kebijakan merge tim.

---

## 4. Push lewat installation token, dan status signature

### 4.1 Apakah kepemilikan token memengaruhi hitungan kontribusi

**[VERIFIED-DOC]** Daftar syarat kontribusi di
[Profile contributions reference](https://docs.github.com/en/account-and-profile/reference/profile-contributions-reference)
sepenuhnya soal isi objek commit (email author, repo, branch) dan hubungan akun
dengan repo. Identitas pusher atau kredensial yang dipakai push **tidak disebut sama
sekali**.

**[INFERENSI]** Karena itu, push lewat installation token `factory[bot]` tidak
mengubah perhitungan kontribusi; yang dibaca hanya email author (dan co-author) di
dalam commit. Ini inferensi dari ketiadaan syarat, bukan pernyataan positif GitHub.
Identitas token tetap terlihat di tempat lain (event push, audit log, badge "pushed
by"), tapi bukan di grafik kontribusi.

### 4.2 Apakah commit jadi unsigned kalau author-nya kita tentukan

**[VERIFIED-DOC]** Untuk commit yang dibuat lewat API,
[About commit signature verification](https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification)
menyatakan: "Signature verification for bots will only work if the request is verified
and authenticated as the GitHub App or bot and **contains no custom author information,
custom committer information, and no custom signature information**, such as Commits
API." Ini mengonfirmasi temuan yang sudah tercatat di spec untuk jalur Git Data API.

**[VERIFIED-DOC]** GitHub hanya menandatangani otomatis commit yang **ia sendiri
buat**: "GitHub will automatically use GPG to sign commits you make using the web
interface." Tidak ada klaim serupa untuk commit yang di-push lewat Git.

**[INFERENSI]** Commit git biasa yang dibuat di dalam Sandbox dan di-push lewat HTTPS
dengan installation token **selalu unsigned**, terlepas dari siapa author-nya — bukan
karena kita menyebut author, tapi karena tidak ada kunci penandatangan yang dipakai
di sisi kita dan GitHub tidak menandatangani commit yang bukan buatannya. Jadi
pertanyaan "apakah menyebut author membuat commit unsigned" tidak berlaku di jalur
push biasa: ia sudah unsigned sejak awal. Yang berlaku hanya di jalur Commits/Git
Data API.

**[VERIFIED-DOC]** Risiko yang perlu dinyatakan: kalau manusia mengaktifkan **vigilant
mode**, commit tak bertanda tangan yang author-nya dia akan ditandai "Unverified" —
"The commit is not signed and an author has enabled vigilant mode." Vigilant mode
mati secara default.

**[VERIFIED-EMPIRIS]** Commit hasil squash sendiri **bertanda tangan** dan `verified`,
karena GitHub yang membuatnya (§2.1). Jadi di default branch, yang terlihat adalah
commit terverifikasi milik `factory[bot]` — commit unsigned dari Sandbox tidak pernah
mendarat di sana kalau kebijakan merge-nya squash.

---

## 5. Batas untuk repo privat

**[VERIFIED-DOC]** [Profile contributions reference](https://docs.github.com/en/account-and-profile/reference/profile-contributions-reference):
"When you publicize private contributions, people without access to those private
repositories will see the number of contributions you made each day. They will not
see specific details."

**[VERIFIED-DOC]** Setelan itu manual, per akun, dan **tidak bisa diatur dari sisi
kita**: profil → di atas kalender kontribusi → **Contribution settings** → **Private
contributions**
([Manage visibility settings for private contributions](https://docs.github.com/en/account-and-profile/how-tos/contribution-settings/manage-visibility-settings-for-private-contributions-and-achievements)).

Artinya untuk repo `product` dan repo tim yang privat: kontribusi tetap dihitung dan
tetap terlihat oleh yang punya akses repo, tapi **tidak muncul ke publik** kecuali
tiap orang menyalakan setelan itu di profilnya sendiri. Ini di luar kendali sistem;
paling jauh kita bisa mendokumentasikannya sebagai langkah onboarding.

---

## 6. Konsekuensi untuk desain, dan pilihan yang tersisa

Premis lama: *author = Principal pemicu Run, committer = `factory[bot]`, atribusi
selamat sampai grafik kontribusi.* Bagian pertama masih bisa dipasang, bagian
terakhir tidak selamat kalau tim memakai squash merge.

Tiga jalur, diurutkan dari yang paling murah:

1. **Terima `Co-authored-by:` sebagai jalur atribusi resmi.** Tidak ada izin baru,
   tidak ada perubahan kebijakan merge, tidak ada kode tambahan — GitHub menulis
   trailer itu sendiri asalkan author commit di dalam Sandbox memakai noreply manusia.
   Yang berubah hanya narasi: di default branch, author terlihat `factory[bot]` dan
   manusia muncul sebagai co-author. Grafik kontribusi tetap terisi.
2. **Ganti kebijakan merge ke rebase merge.** Author manusia sampai utuh ke default
   branch, commit per commit. Harganya: signature verification hilang untuk seluruh
   commit yang di-rebase, riwayat default branch memuat setiap commit kerja Agent, dan
   ini keputusan tim, bukan keputusan sistem.
3. **Merge commit biasa.** Author manusia utuh, signature commit asli utuh. Harganya
   riwayat penuh dari cabang Agent masuk ke default branch.

Rekomendasi: **jalur 1**, dengan §5 didokumentasikan sebagai langkah onboarding
manusia (nyalakan Private contributions). Jalur 2 dan 3 tetap valid kalau tim memang
ingin author manusia terlihat di baris pertama, tapi itu perubahan kebijakan tim yang
harus dinyatakan eksplisit, bukan efek samping desain.

Yang tetap harus dipasang, apa pun jalurnya: `git config user.name` / `user.email`
di dalam Sandbox ke identitas noreply manusia pemicu Run.

---

## Gap yang belum terverifikasi

1. **Apakah trailer otomatis bisa hilang karena setelan pesan squash.** Sebagian
   terjawab: pada microsandbox#78 body PR sepanjang 1376 karakter tidak ikut masuk ke
   pesan commit, tapi `Co-authored-by:` tetap ada — jadi trailer ditambahkan **di luar**
   isi pesan yang dikonfigurasi lewat
   [Configuring commit squashing](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/configuring-commit-squashing-for-pull-requests).
   Yang **belum** diuji: `gh pr merge --squash --body "..."` dan penyuntingan manual
   pesan di UI, yang menimpa isi pesan secara eksplisit. Dokumentasi tidak menyatakan
   apakah trailer tetap ditambahkan dalam kasus itu. Kalau alur merge tim memakai
   `--body`, ini harus dites sebelum jalur 1 dikunci.
2. **Tanggal yang dipakai grafik untuk kredit co-author.** Grafik memakai author date;
   untuk co-author, author date yang relevan hampir pasti milik commit squash (waktu
   merge), bukan waktu commit di Sandbox. Tidak saya temukan pernyataan resminya.
   Efek praktis: kontribusi jatuh di hari merge, bukan hari kerja Agent.
3. ~~Apakah GitHub menambahkan trailer untuk author yang identik dengan pembuka PR.~~
   Terjawab: ya (microsandbox#78, author dan co-author sama-sama `github-actions[bot]`).
4. **Perilaku squash saat cabang memuat commit dari lebih dari satu author manusia.**
   Changelog 2019 menyatakan "_every_ commit author" jadi co-author, tapi sampel
   empiris saya semuanya satu author manusia. Klaimnya [VERIFIED-DOC], bukan
   [VERIFIED-EMPIRIS].
5. **Setelan merge repo `aio-libs/aiohttp`** (`squash_merge_commit_message`) tidak
   terbaca lewat API tanpa hak admin, jadi konfigurasi persisnya tidak diketahui.
