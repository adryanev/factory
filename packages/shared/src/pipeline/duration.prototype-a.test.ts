/**
 * Varian A: satu tabel, baris melempar memakai field `throws` di tempat
 * `expected`. Callback bercabang atas ada-tidaknya field itu.
 *
 * Baris "nol di depan ditolak" sengaja merah: regex-nya salah.
 */
import { describe, expect, it } from "vitest";
import { parseDuration } from "./duration.js";

describe("parseDuration — varian A", () => {
  it.each([
    { case: "milidetik", input: "60ms", expected: 60 },
    { case: "menit", input: "45m", expected: 45 * 60_000 },
    { case: "string kosong ditolak", input: "", throws: /invalid duration/ },
    { case: "unit huruf besar ditolak", input: "2H", throws: /invalid duration/ },
    { case: "nol di depan ditolak", input: "0m", throws: /must be positive/ },
  ])("$case", (row) => {
    if ("throws" in row) {
      expect(() => parseDuration(row.input)).toThrow(row.throws);
      return;
    }
    expect(parseDuration(row.input)).toBe(row.expected);
  });
});
