import { describe, expect, it } from "vitest";
import { decodeBase32, encodeBase32, generateId, ID_PREFIXES, isValidId } from "./id.js";

describe("base32 codec", () => {
  type Base32RoundTripCase = {
    case: string;
    bytes: Uint8Array;
  };

  it.each([
    { case: "kosong", bytes: new Uint8Array(0) },
    { case: "satu elemen", bytes: new Uint8Array([0x7f]) },
    { case: "16 byte semuanya nol", bytes: new Uint8Array(16) },
    { case: "16 byte semuanya 0xff", bytes: new Uint8Array(16).fill(0xff) },
    { case: "ramp: tiap byte i*17", bytes: Uint8Array.from({ length: 16 }, (_, i) => i * 17) },
    {
      case: "pseudo-acak",
      bytes: Uint8Array.from({ length: 16 }, (_, i) => (i * 97 + 3) % 256),
    },
  ] satisfies Base32RoundTripCase[])("$case", ({ bytes }) => {
    expect(decodeBase32(encodeBase32(bytes), bytes.length)).toEqual(bytes);
  });

  const sixteenBytes = Uint8Array.from({ length: 16 }, (_, i) => i * 17);
  const encodedSixteenBytes = encodeBase32(sixteenBytes); // 26 karakter, sesuai BODY_LENGTH di id.ts:67

  type DecodeBase32Case =
    | { case: string; input: string; byteLength: number; expected: Uint8Array; throws?: never }
    | { case: string; input: string; byteLength: number; throws: RegExp; expected?: never };

  // lewati: input/separator — format body base32 tidak berseparator; BASE32_ALPHABET di id.ts:21 adalah alfabet murni
  it.each([
    {
      case: "huruf besar ditolak — alfabet hanya huruf kecil",
      input: "0123456789ABCDEFGHJKMNPQRST",
      byteLength: 16,
      throws: /invalid base32 character: "A"/,
    },
    {
      case: "huruf i ditolak — dikecualikan dari alfabet Crockford",
      input: "i",
      byteLength: 16,
      throws: /invalid base32 character: "i"/,
    },
    {
      case: "huruf l ditolak — dikecualikan dari alfabet Crockford",
      input: "l",
      byteLength: 16,
      throws: /invalid base32 character: "l"/,
    },
    {
      case: "huruf o ditolak — dikecualikan dari alfabet Crockford",
      input: "o",
      byteLength: 16,
      throws: /invalid base32 character: "o"/,
    },
    {
      case: "huruf u ditolak — dikecualikan dari alfabet Crockford",
      input: "u",
      byteLength: 16,
      throws: /invalid base32 character: "u"/,
    },
    {
      case: "karakter di luar alfabet ditolak",
      input: "0123456789abcdefghjkmnpqrst!",
      byteLength: 16,
      throws: /invalid base32 character: "!"/,
    },
    {
      case: "hanya whitespace ditolak",
      input: "   ",
      byteLength: 16,
      throws: /invalid base32 character: " "/,
    },
    {
      case: "string kosong: seluruh byte tetap nol",
      input: "",
      byteLength: 16,
      expected: new Uint8Array(16),
    },
    {
      case: "input satu karakter lebih pendek: byte terakhir tetap nol (id.ts:113)",
      input: encodedSixteenBytes.slice(0, 25),
      byteLength: 16,
      expected: Uint8Array.of(...sixteenBytes.subarray(0, 15), 0),
    },
    {
      case: "input satu karakter lebih panjang: kelebihan dibuang (id.ts:126)",
      input: encodedSixteenBytes + "0",
      byteLength: 16,
      expected: sixteenBytes,
    },
    {
      case: "byteLength nol: hasil array kosong",
      input: encodedSixteenBytes,
      byteLength: 0,
      expected: new Uint8Array(0),
    },
    {
      case: "byteLength negatif: RangeError dari konstruktor Uint8Array (id.ts:113)",
      input: "",
      byteLength: -1,
      throws: /Invalid typed array length: -1/,
    },
  ] satisfies DecodeBase32Case[])("$case", (row) => {
    if ("throws" in row) {
      expect(() => decodeBase32(row.input, row.byteLength)).toThrow(row.throws);
      return;
    }
    expect(decodeBase32(row.input, row.byteLength)).toEqual(row.expected);
  });
});

describe("generateId", () => {
  // prosa: klausa 4 — yang bervariasi urutan kejadian (jam), bukan input. Klausa 2 tidak menyala: assertion di luar loop, 50 titik data = satu kasus, bukan 50
  it("time-ordered: id pada timestamp menaik terurut leksikografis", () => {
    let tick = 1_700_000_000_000;
    const clock = () => tick;
    const ids = Array.from({ length: 50 }, () => {
      const id = generateId("probe", { now: clock });
      tick += 1;
      return id;
    });
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  // prosa: klausa 3 — invariant struktural: output generateId selalu lolos isValidId
  it("round-trip lewat isValidId", () => {
    const id = generateId("probe");
    expect(isValidId("probe", id)).toBe(true);
  });

  // prosa: klausa 3 — invariant struktural bentuk id (prefiks, separator, body 26 karakter)
  it("bentuk stabil: prefiks, separator, body 26 karakter", () => {
    const id = generateId("probe");
    expect(id).toMatch(/^probe_[0-9a-hj-km-np-tv-z]{26}$/);
  });

  // prosa: klausa 3 — invariant struktural keluaran. Klausa 7 tidak menyala: himpunan karakter yang ditolak git milik spesifikasi git, bukan kode produksi
  it("aman sebagai komponen git ref: satu case, tanpa karakter cadangan", () => {
    const id = generateId("probe");
    expect(id).toBe(id.toLowerCase());
    expect(id).not.toMatch(/[\s~^:?*[\]\\@]/);
    expect(id).not.toContain("..");
    expect(id.endsWith(".lock")).toBe(false);
  });

  // prosa: klausa 3 — invariant determinisme: seed sama → id sama
  it("client-generatable: fungsi murni dari jam dan keacakan yang disuntik", () => {
    const fixedRandom = () => new Uint8Array(10).fill(0x42);
    const id = generateId("probe", { now: () => 1_700_000_000_000, randomBytes: fixedRandom });
    const again = generateId("probe", { now: () => 1_700_000_000_000, randomBytes: fixedRandom });
    expect(id).toBe(again);
  });

  // prosa: klausa 3 — invariant struktural: id memakai prefiks yang diminta
  it("memakai prefiks yang diminta", () => {
    const id = generateId("probe");
    expect(isValidId("probe", id)).toBe(true);
    expect(id.startsWith("probe_")).toBe(true);
  });
});

describe("ID_PREFIXES", () => {
  // prosa: klausa 7 — klaim universal atas ID_PREFIXES (id.ts:31), daftar hidup milik kode produksi; menabelkannya menyalin daftar ke test
  it("tidak ada prefiks yang memuat separator `_`, jadi id.split(\"_\")[0] aman", () => {
    for (const prefix of ID_PREFIXES) {
      expect(prefix).not.toContain("_");
    }
  });
});
