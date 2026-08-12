import { expect, it } from "vitest";

import { parseDuration } from "./pipeline/duration.js";

// VARIAN C — anotasi biasa `const rows: Case[] =`, union TANPA `?: never`.

type Case =
  | { case: string; input: string; expected: number }
  | { case: string; input: string; throws: RegExp };

// C0 — tabel bersih: narrowing harus tetap bekerja, tsc harus diam
const c0: Case[] = [
  { case: "ok", input: "60ms", expected: 60 },
  { case: "kosong ditolak", input: "", throws: /invalid duration/ },
];
it.each(c0)("C0 $case", (row) => {
  if ("throws" in row) {
    expect(() => parseDuration(row.input)).toThrow(row.throws);
    return;
  }
  expect(parseDuration(row.input)).toBe(row.expected);
});

// D1 — baris sukses kehilangan field `expected`
const c1: Case[] = [
  { case: "ok", input: "60ms", expected: 60 },
  { case: "lupa hasil", input: "45m" },
];
it.each(c1)("C-D1 $case", (row) => {
  if ("throws" in row) {
    expect(() => parseDuration(row.input)).toThrow(row.throws);
    return;
  }
  expect(parseDuration(row.input)).toBe(row.expected);
});

// D2 — satu kolom salah tipe
const c2: Case[] = [
  { case: "ok", input: "60ms", expected: 60 },
  { case: "salah tipe", input: "45m", expected: "2700000" },
];
it.each(c2)("C-D2 $case", (row) => {
  if ("throws" in row) {
    expect(() => parseDuration(row.input)).toThrow(row.throws);
    return;
  }
  expect(parseDuration(row.input)).toBe(row.expected);
});

// D3 — typo `throw:` bukan `throws:`
const c3: Case[] = [
  { case: "ok", input: "60ms", expected: 60 },
  { case: "typo penanda lempar", input: "", throw: /invalid duration/ },
];
it.each(c3)("C-D3 $case", (row) => {
  if ("throws" in row) {
    expect(() => parseDuration(row.input)).toThrow(row.throws);
    return;
  }
  expect(parseDuration(row.input)).toBe(row.expected);
});

// D4 — satu baris membawa `expected` DAN `throws`
const c4: Case[] = [
  { case: "ok", input: "60ms", expected: 60 },
  { case: "dua-duanya", input: "", expected: 0, throws: /invalid duration/ },
];
it.each(c4)("C-D4 $case", (row) => {
  if ("throws" in row) {
    expect(() => parseDuration(row.input)).toThrow(row.throws);
    return;
  }
  expect(parseDuration(row.input)).toBe(row.expected);
});
