import { expect, it } from "vitest";

import { parseDuration } from "./pipeline/duration.js";

// VARIAN D — union dua arm DENGAN `?: never` eksplisit, dipakai lewat
// `satisfies` dan lewat anotasi. Yang diukur khusus: baris D4 (membawa
// `expected` dan `throws` sekaligus) dan apakah `?: never` mengubah narrowing.

type CaseNever =
  | { case: string; input: string; expected: number; throws?: never }
  | { case: string; input: string; throws: RegExp; expected?: never };

// D0 — bersih, lewat satisfies
it.each([
  { case: "ok", input: "60ms", expected: 60 },
  { case: "kosong ditolak", input: "", throws: /invalid duration/ },
] satisfies CaseNever[])("D0 $case", (row) => {
  if ("throws" in row) {
    expect(() => parseDuration(row.input)).toThrow(row.throws);
    return;
  }
  expect(parseDuration(row.input)).toBe(row.expected);
});

// D4s — dua-duanya, lewat satisfies
it.each([
  { case: "ok", input: "60ms", expected: 60 },
  { case: "dua-duanya", input: "", expected: 0, throws: /invalid duration/ },
] satisfies CaseNever[])("D4s $case", (row) => {
  if ("throws" in row) {
    expect(() => parseDuration(row.input)).toThrow(row.throws);
    return;
  }
  expect(parseDuration(row.input)).toBe(row.expected);
});

// D4a — dua-duanya, lewat anotasi
const d4a: CaseNever[] = [
  { case: "ok", input: "60ms", expected: 60 },
  { case: "dua-duanya", input: "", expected: 0, throws: /invalid duration/ },
];
it.each(d4a)("D4a $case", (row) => {
  if ("throws" in row) {
    expect(() => parseDuration(row.input)).toThrow(row.throws);
    return;
  }
  expect(parseDuration(row.input)).toBe(row.expected);
});

// D1a — lupa field hasil, lewat anotasi + never
const d1a: CaseNever[] = [
  { case: "ok", input: "60ms", expected: 60 },
  { case: "lupa hasil", input: "45m" },
];
it.each(d1a)("D1a $case", (row) => {
  if ("throws" in row) {
    expect(() => parseDuration(row.input)).toThrow(row.throws);
    return;
  }
  expect(parseDuration(row.input)).toBe(row.expected);
});
