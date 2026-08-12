import { expect, it } from "vitest";

import { parseDuration } from "./pipeline/duration.js";

// VARIAN F — apakah error kedua yang muncul di varian B (TS2345 di dalam
// callback) itu melekat pada `satisfies`, atau cuma artefak tabel probe yang
// baris melemparnya cuma satu lalu hilang oleh cacatnya sendiri.

type Case =
  | { case: string; input: string; expected: number; throws?: never }
  | { case: string; input: string; throws: RegExp; expected?: never };

// F1 — satisfies, DUA baris melempar yang sehat + satu baris sukses cacat
it.each([
  { case: "ok", input: "60ms", expected: 60 },
  { case: "kosong ditolak", input: "", throws: /invalid duration/ },
  { case: "huruf besar ditolak", input: "2H", throws: /invalid duration/ },
  { case: "lupa hasil", input: "45m" },
] satisfies Case[])("F1 $case", (row) => {
  if ("throws" in row) {
    expect(() => parseDuration(row.input)).toThrow(row.throws);
    return;
  }
  expect(parseDuration(row.input)).toBe(row.expected);
});

// F2 — pembanding tanpa anotasi: tabel yang sama, cacat yang sama
it.each([
  { case: "ok", input: "60ms", expected: 60 },
  { case: "kosong ditolak", input: "", throws: /invalid duration/ },
  { case: "huruf besar ditolak", input: "2H", throws: /invalid duration/ },
  { case: "lupa hasil", input: "45m" },
])("F2 $case", (row) => {
  if ("throws" in row) {
    expect(() => parseDuration(row.input)).toThrow(row.throws);
    return;
  }
  expect(parseDuration(row.input)).toBe(row.expected);
});
