/**
 * Varian B: dua tabel terpisah di satu `describe` — satu untuk yang
 * mengembalikan, satu untuk yang melempar. Tiap tabel punya bentuk baris
 * sendiri dan callback lurus tanpa cabang.
 *
 * Baris "nol di depan ditolak" sengaja merah: regex-nya salah.
 */
import { describe, expect, it } from "vitest";
import { parseDuration } from "./duration.js";

describe("parseDuration — varian B", () => {
  it.each([
    { case: "milidetik", input: "60ms", expected: 60 },
    { case: "menit", input: "45m", expected: 45 * 60_000 },
  ])("$case", ({ input, expected }) => {
    expect(parseDuration(input)).toBe(expected);
  });

  it.each([
    { case: "string kosong ditolak", input: "", message: /invalid duration/ },
    { case: "unit huruf besar ditolak", input: "2H", message: /invalid duration/ },
    { case: "nol di depan ditolak", input: "0m", message: /must be positive/ },
  ])("$case", ({ input, message }) => {
    expect(() => parseDuration(input)).toThrow(message);
  });
});
