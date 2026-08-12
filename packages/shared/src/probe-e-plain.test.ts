import { expect, it } from "vitest";

import { parseDuration } from "./pipeline/duration.js";

// VARIAN E — tabel tanpa baris melempar (kasus mayoritas), callback lurus.
// Yang diukur: apakah inferensi benar-benar DIAM atas baris cacat ketika tidak
// ada cabang `"throws" in row` yang menyeret error palsu ke dalam callback.

// E1 — tanpa anotasi, baris kehilangan `expected`
it.each([
  { case: "ok", input: "60ms", expected: 60 },
  { case: "lupa hasil", input: "45m" },
])("E1 $case", ({ input, expected }) => {
  expect(parseDuration(input)).toBe(expected);
});

// E2 — tanpa anotasi, satu kolom salah tipe
it.each([
  { case: "ok", input: "60ms", expected: 60 },
  { case: "salah tipe", input: "45m", expected: "2700000" },
])("E2 $case", ({ input, expected }) => {
  expect(parseDuration(input)).toBe(expected);
});

type Row = { case: string; input: string; expected: number };

// E3 — anotasi lewat parameter tipe `it.each<Row>` (inline, tanpa const)
it.each<Row>([
  { case: "ok", input: "60ms", expected: 60 },
  { case: "lupa hasil", input: "45m" },
  { case: "salah tipe", input: "45m", expected: "2700000" },
  { case: "typo kolom", input: "45m", expcted: 2_700_000 },
])("E3 $case", ({ input, expected }) => {
  expect(parseDuration(input)).toBe(expected);
});

// E4 — pembanding: satisfies pada tabel non-melempar (tipe tunggal, bukan union)
it.each([
  { case: "ok", input: "60ms", expected: 60 },
  { case: "lupa hasil", input: "45m" },
] satisfies Row[])("E4 $case", ({ input, expected }) => {
  expect(parseDuration(input)).toBe(expected);
});

type CaseNever =
  | { case: string; input: string; expected: number; throws?: never }
  | { case: string; input: string; throws: RegExp; expected?: never };

// E5 — parameter tipe generik atas union+never: apakah narrowing tetap jalan
// dan baris cacat tetap ditolak di barisnya
it.each<CaseNever>([
  { case: "ok", input: "60ms", expected: 60 },
  { case: "kosong ditolak", input: "", throws: /invalid duration/ },
  { case: "dua-duanya", input: "", expected: 0, throws: /invalid duration/ },
])("E5 $case", (row) => {
  if ("throws" in row) {
    expect(() => parseDuration(row.input)).toThrow(row.throws);
    return;
  }
  expect(parseDuration(row.input)).toBe(row.expected);
});
