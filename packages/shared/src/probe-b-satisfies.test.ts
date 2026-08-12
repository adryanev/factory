import { expect, it } from "vitest";

import { parseDuration } from "./pipeline/duration.js";

// VARIAN B — `satisfies Case[]`, union dua arm TANPA `?: never` eksplisit.

type Case =
  | { case: string; input: string; expected: number }
  | { case: string; input: string; throws: RegExp };

// B0 — tabel bersih: narrowing harus tetap bekerja, tsc harus diam
it.each([
  { case: "ok", input: "60ms", expected: 60 },
  { case: "kosong ditolak", input: "", throws: /invalid duration/ },
] satisfies Case[])("B0 $case", (row) => {
  if ("throws" in row) {
    expect(() => parseDuration(row.input)).toThrow(row.throws);
    return;
  }
  expect(parseDuration(row.input)).toBe(row.expected);
});

// D1 — baris sukses kehilangan field `expected`
it.each([
  { case: "ok", input: "60ms", expected: 60 },
  { case: "lupa hasil", input: "45m" },
] satisfies Case[])("B-D1 $case", (row) => {
  if ("throws" in row) {
    expect(() => parseDuration(row.input)).toThrow(row.throws);
    return;
  }
  expect(parseDuration(row.input)).toBe(row.expected);
});

// D2 — satu kolom salah tipe
it.each([
  { case: "ok", input: "60ms", expected: 60 },
  { case: "salah tipe", input: "45m", expected: "2700000" },
] satisfies Case[])("B-D2 $case", (row) => {
  if ("throws" in row) {
    expect(() => parseDuration(row.input)).toThrow(row.throws);
    return;
  }
  expect(parseDuration(row.input)).toBe(row.expected);
});

// D3 — typo `throw:` bukan `throws:`
it.each([
  { case: "ok", input: "60ms", expected: 60 },
  { case: "typo penanda lempar", input: "", throw: /invalid duration/ },
] satisfies Case[])("B-D3 $case", (row) => {
  if ("throws" in row) {
    expect(() => parseDuration(row.input)).toThrow(row.throws);
    return;
  }
  expect(parseDuration(row.input)).toBe(row.expected);
});

// D4 — satu baris membawa `expected` DAN `throws`
it.each([
  { case: "ok", input: "60ms", expected: 60 },
  { case: "dua-duanya", input: "", expected: 0, throws: /invalid duration/ },
] satisfies Case[])("B-D4 $case", (row) => {
  if ("throws" in row) {
    expect(() => parseDuration(row.input)).toThrow(row.throws);
    return;
  }
  expect(parseDuration(row.input)).toBe(row.expected);
});
