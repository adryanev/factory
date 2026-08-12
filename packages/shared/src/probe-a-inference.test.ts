import { expect, it } from "vitest";

import { parseDuration } from "./pipeline/duration.js";

// VARIAN A — tanpa anotasi apa pun (bentuk #50 apa adanya).
// Empat cacat baris, masing-masing satu tabel. Yang diukur: apakah tsc menolak,
// dan di baris mana ia menunjuk.

// D1 — baris sukses kehilangan field `expected`
it.each([
  { case: "ok", input: "60ms", expected: 60 },
  { case: "lupa hasil", input: "45m" },
])("D1 $case", (row) => {
  if ("throws" in row) {
    expect(() => parseDuration(row.input)).toThrow(row.throws);
    return;
  }
  expect(parseDuration(row.input)).toBe(row.expected);
});

// D2 — satu kolom salah tipe (`expected` string di antara number)
it.each([
  { case: "ok", input: "60ms", expected: 60 },
  { case: "salah tipe", input: "45m", expected: "2700000" },
])("D2 $case", (row) => {
  if ("throws" in row) {
    expect(() => parseDuration(row.input)).toThrow(row.throws);
    return;
  }
  expect(parseDuration(row.input)).toBe(row.expected);
});

// D3 — typo nama field: `throw:` bukan `throws:`
it.each([
  { case: "ok", input: "60ms", expected: 60 },
  { case: "typo penanda lempar", input: "", throw: /invalid duration/ },
])("D3 $case", (row) => {
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
])("D4 $case", (row) => {
  if ("throws" in row) {
    expect(() => parseDuration(row.input)).toThrow(row.throws);
    return;
  }
  expect(parseDuration(row.input)).toBe(row.expected);
});
