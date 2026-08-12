# Test table-driven untuk unit logika murni

Dokumen ini dibaca **sebelum** menulis atau mengubah sebuah unit test logika
murni. Jalankan dari atas ke bawah: empat langkah, masing-masing menjawab satu
pertanyaan.

**Lingkupnya**: unit logika murni — `packages/shared/src/**`, unit test di
`packages/runner/src/**`, dan `packages/control-plane/test/unit/**`.

**Di luar lingkupnya**: suite integrasi (`seam1`, `sql`, `garage`, `db`,
`openapi`). Satu baris tabel di sana berarti satu perjalanan ke database, dan
sumbu yang menarik biasanya keadaan, bukan input. Tabel tetap boleh dipakai bila
cocok; dokumen ini tidak mengaturnya.

Yang dikejar aturan ini adalah **celah cakupan di ruang input**, bukan duplikasi.
Duplikasi hanyalah gejalanya. Sebuah tabel membuat baris yang hilang terlihat.

---

## Langkah 1 — Apakah test ini wajib berbentuk tabel?

Pemicunya menempel pada ruang input, bukan pada jumlah `it()` bersaudara dan
bukan pada bentuk tanda tangan fungsi.

### Wajib tabel bila salah satu menyala

1. **Sumber cacah yang bisa ditunjuk.** Ruang inputnya terbagi habis menjadi
   kelas-kelas yang sudah tertulis **di luar** test — union tertutup, enum,
   tabel di spec, atau batas terdokumentasi. Reviewer menunjuk sumbernya; ia
   tidak menilai selera.
2. **Tabel tersembunyi.** Ada loop yang assertion-nya berada **di dalam** loop
   **dan** koleksinya adalah literal yang ditulis di file test itu. Kedua syarat
   harus terpenuhi sekaligus.

### Sah tetap `it()` prosa bila salah satu menyala

3. **Yang ditanya bukan sebuah baris** — menegaskan identitas konstanta atau
   invariant struktural, bukan pemetaan input → output.
4. **Yang bervariasi bukan input, melainkan keadaan dunia atau urutan kejadian.**
5. **Persiapan tiap kasus berbeda** — bila baris hanya bisa berbagi satu badan
   `expect` dengan menyelundupkan flag pencabang ke dalamnya, tabelnya
   dipaksakan; batalkan.
6. **Baris saling bergantung** — hasil baris N bergantung pada baris N−1. Itu
   narasi, bukan tabel.
7. **Klaim universal atas himpunan milik kode produksi.** Menabelkannya menyalin
   daftar hidup ke dalam test; anggota baru besok tidak akan teruji.

### Dua putusan yang menempel

- **Pengecualian menang atas pemicu** bila keduanya menyala. Tabel membayar
  dengan stack trace yang menunjuk ke baris `expect` bersama, dan harga itu
  hanya sepadan bila barisnya memang sebaris. Pagarnya: penolak **wajib menyebut
  nomor pengecualiannya dan menunjuk penghalang konkretnya** — bukan "rasanya
  tidak cocok".
- **Banyak `expect` di dalam satu baris bukan tabel tersembunyi.** Klausa 2
  mencacah kasus, bukan assertion di dalam satu kasus. Sebuah baris boleh
  membawa `expectedFragments: string[]`.

Satu file boleh berisi tabel **dan** `it()` prosa berdampingan. Itu keadaan
normal, bukan bau yang harus dibereskan.

---

## Langkah 2 — Bentuk tabelnya

`it.each` atas **array of object**, judul selalu `"$case"`, tipe baris ditempel
lewat `satisfies` di ujung array.

```ts
type RedactorCase = {
  case: string;
  secrets: string[];
  input: string;
  expected: string;
};

it.each([
  {
    case: "satu secret muncul berkali-kali",
    secrets: ["abc123"],
    input: "abc123 abc 123 abc123",
    expected: "[redacted] abc 123 [redacted]",
  },
] satisfies RedactorCase[])("$case", ({ secrets, input, expected }) => {
  expect(createLiteralRedactor(secrets)(input)).toBe(expected);
});
```

Aturannya:

1. **Tiap baris wajib punya field `case: string`**, dan judul tabel selalu
   `"$case"`. Panjang label tidak diatur; reporter memotong judul di 38 karakter,
   jadi baris merah kadang harus dicocokkan lewat prefiksnya.
2. **Tidak ada cabang untuk sumbu tunggal.** Tabel satu sumbu skalar juga memakai
   bentuk objek.
3. **`satisfies`, bukan anotasi pada `const` terpisah.** Diagnostiknya identik,
   tapi `satisfies` menahan tabel tetap inline di dalam `it.each([...])`.
4. **Nama tipe = unit yang diuji + `Case`**, dideklarasikan tepat di atas
   tabelnya, tidak diekspor. Tidak ada tipe `Case` bersama, generik, atau file
   tipe terpusat: satu tabel, satu deklarasi, mati bersama tabelnya.
5. **`it.each<Case>([...])` dilarang.** Vitest memilih overload tuple untuk
   parameter tipe eksplisit, jadi callback-nya menjadi `(...args: Case)` dan
   seluruh callback kehilangan tipe.

Anotasi ini yang membeli: baris yang lupa kolom hasil (`TS2741`), kolom salah
tipe (`TS2322`), typo nama kolom (`TS2561`), dan typo penanda lempar (`TS2353`)
— semuanya **di baris yang cacat**. Tanpa anotasi, keempatnya diam.

---

## Langkah 3 — Barisnya apa saja: checklist ruang input

Untuk **tiap parameter**, cari tipenya, lalu pastikan tabel punya baris untuk
tiap sumbu di bawah tipe itu.

**string**

- kosong (`""`)
- hanya whitespace
- beda case — bila alfabetnya membatasi case
- karakter di luar alfabet yang diizinkan
- separator di awal, di akhir, dan berulang — bila formatnya punya separator
- tepat di batas panjang, dan satu di atasnya — bila batas ada

**koleksi (array, Set, Map)**

- kosong
- satu elemen
- lebih dari satu
- duplikat
- elemen yang sendirinya kosong

**numerik**

- nol
- negatif — bila tipenya mengizinkan
- tepat di batas, satu di bawah, satu di atas — untuk **tiap** batas
  terdokumentasi

**union / enum tertutup**

- satu baris per arm, tanpa pengecualian
- satu nilai di luar himpunan, bila fungsinya menerima tipe lebih lebar lalu
  menyempitkannya (`isArtifactKind(value: string)`)

**opsional / nullable**

- ada
- `undefined`
- `null` — hanya bila tipenya mengizinkan, bukan dua baris otomatis

### Tiga aturan penerapan

1. **Per parameter, bukan per fungsi.** `decodeBase32(input: string, byteLength:
   number)` diaudit oleh blok string **dan** blok numerik.
2. **Tidak ada perkalian kartesian.** Kombinasi dua sumbu wajib **hanya** bila
   interaksinya tertulis di kode atau spec.
3. **Checklist hanya mengikat tabel.** `it()` prosa yang sah lewat salah satu
   pengecualian Langkah 1 tidak diaudit olehnya — itu sebabnya pagar "penolak
   wajib menyebut nomor pengecualiannya" menanggung beban besar.

### Menandai sumbu yang dilewati

Komentar `lewati:` tepat di atas `it.each([`, satu baris per sumbu, **hanya untuk
sumbu yang dilewati**:

```ts
// lewati: separator — DURATION_PATTERN di duration.ts:8 tidak punya separator
// lewati: panjang — tidak ada batas panjang di DURATION_PATTERN
it.each([...] satisfies ParseDurationCase[])("$case", (row) => { ... });
```

- **Wajib menunjuk referen, bukan memberi alasan.** Format:
  `lewati: <sumbu> — <referen yang tidak ada>`, menyebut file dan simbol, atau
  menyatakan ketiadaan yang bisa dicek. "Rasanya tidak relevan" ditolak.
- **Sumbu yang tipenya tidak ada di tanda tangan tidak ditulis.**
  `isValidKey(value: string)` tidak berutang komentar untuk blok koleksi,
  numerik, atau union — ketiadaannya sudah terbaca dari tanda tangan. Hanya sumbu
  yang **tipenya ada tapi referennya tidak** yang perlu ditulis.
- **Lebih dari satu parameter: sebut parameternya** — `lewati: secrets/duplikat —
  …`.
- **Tanpa komentar dan tanpa baris = lupa.** Itu seluruh gunanya.

Bentuk ini hidup karena ia **membusuk secara terlihat**: begitu batas panjang
ditambahkan di kode produksi, komentar yang menyatakan "tidak ada batas" menjadi
salah tepat di sebelah test yang dilanggarnya.

---

## Langkah 4 — Baris yang melempar

**Satu tabel.** Baris yang melempar membawa `throws: RegExp` di tempat
`expected`, dan callback bercabang atas `"throws" in row`.

```ts
type ParseDurationCase =
  | { case: string; input: string; expected: number; throws?: never }
  | { case: string; input: string; throws: RegExp; expected?: never };

it.each([
  { case: "milidetik", input: "60ms", expected: 60 },
  { case: "menit", input: "45m", expected: 45 * 60_000 },
  { case: "string kosong ditolak", input: "", throws: /invalid duration/ },
] satisfies ParseDurationCase[])("$case", (row) => {
  if ("throws" in row) {
    expect(() => parseDuration(row.input)).toThrow(row.throws);
    return;
  }
  expect(parseDuration(row.input)).toBe(row.expected);
});
```

- **`?: never` ditulis eksplisit di kedua arm.** Hanya itu yang menolak baris
  yang membawa `expected` **dan** `throws` sekaligus. Inferensi juga menstempel
  `?: never`, tapi stempel itu diturunkan dari datanya, jadi ia tidak pernah bisa
  menolak data.
- **`throws` hanya menerima `RegExp`.** Bukan kelas — logika murni di repo ini
  melempar `Error` biasa, jadi kelas tidak membedakan apa pun. Bukan string —
  `toThrow("str")` mencocokkan substring, sehingga pesan yang berubah tapi masih
  memuat potongan lama tetap hijau.
- **Urutan baris mengikuti sumbu checklist, bukan hasil.** Baris melempar duduk
  di sumbunya, bersebelahan dengan baris yang mengembalikan dari sumbu yang sama.

### Fungsi async

Nama field tidak berubah; cara memanggilnya yang berubah.

```ts
if ("throws" in row) {
  await expect(f(row.input)).rejects.toThrow(row.throws);
  return;
}
await expect(f(row.input)).resolves.toBe(row.expected);
```

**Panggilan tidak boleh dihoist ke atas cabang.** Hoisting benar untuk async dan
**salah untuk sync**: sebuah throw sinkron di baris itu lolos dari `expect`, dan
barisnya error alih-alih meng-assert.

### Fungsi `void`

Baris suksesnya **tidak membawa `expected` sama sekali**, dan cabang suksesnya
tidak membaca field apa pun dari baris:

```ts
await expect(verifyIsolation(path, probe(row.readable))).resolves.toBeUndefined();
```

`expected: undefined` ditolak: ia kolom yang mengaku menyatakan sesuatu padahal
tidak.

### Baris yang merah karena bug asli

Buka issue, lalu **pindahkan baris itu ke tabel satu-baris sendiri di bawah
`it.fails.each`**, dengan bentuk baris yang sama dan komentar yang menunjuk nomor
issue-nya. Perbaikannya berjalan sebagai perubahan terpisah — retrofit tidak
mencampur refactor dengan perubahan perilaku. (`it.fails` tidak bisa menandai
satu baris di dalam tabel bersama; ia berlaku atas seluruh `it.each`.)

---

## Celah yang tersisa, dinyatakan terbuka

Tabel atas fungsi `void` **kehilangan proteksi "lupa field hasil"**. Baris yang
seharusnya melempar tapi lupa `throws` adalah baris arm sukses yang sah, jadi
`tsc` diam dan ia hanya merah saat dijalankan. Tidak ada bentuk tipe yang bisa
membedakannya selama arm sukses tidak punya satu pun kolom wajib. Ini harga yang
diterima sadar, bukan cacat yang belum sempat diperbaiki.

---

## Asal keputusannya

Peta [#45](https://github.com/adryanev/factory/issues/45): bentuk tabel
[#46](https://github.com/adryanev/factory/issues/46), aturan pemicu
[#47](https://github.com/adryanev/factory/issues/47), checklist ruang input
[#48](https://github.com/adryanev/factory/issues/48), baris melempar
[#50](https://github.com/adryanev/factory/issues/50), ketikan baris
[#51](https://github.com/adryanev/factory/issues/51). Tiap tiket memuat bukti
yang mengunci pilihannya.
