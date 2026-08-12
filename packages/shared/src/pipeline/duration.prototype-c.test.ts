/**
 * Varian C: satu tabel, `expected` boleh berupa nilai **atau** penanda
 * error, dibedakan lewat tipe. Destructure `{ input, expected }` dari #46
 * tetap utuh; cabangnya ada di dalam callback.
 *
 * Baris "nol di depan ditolak" sengaja merah: regex-nya salah.
 */
import { describe, expect, it } from "vitest";
import { parseDuration } from "./duration.js";

describe("parseDuration — varian C", () => {
  it.each([
    { case: "milidetik", input: "60ms", expected: 60 },
    { case: "menit", input: "45m", expected: 45 * 60_000 },
    { case: "string kosong ditolak", input: "", expected: /invalid duration/ },
    { case: "unit huruf besar ditolak", input: "2H", expected: /invalid duration/ },
    { case: "nol di depan ditolak", input: "0m", expected: /must be positive/ },
  ])("$case", ({ input, expected }) => {
    if (expected instanceof RegExp) {
      expect(() => parseDuration(input)).toThrow(expected);
      return;
    }
    expect(parseDuration(input)).toBe(expected);
  });
});
