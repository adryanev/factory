/**
 * PROBE #50 — kegagalan `tsc --noEmit` ADALAH temuannya, bukan bug.
 * Varian A, field `throws` salah tulis jadi `throw`. Harapan: tsc menolak.
 * Terukur: TS2345 di baris `expect` DI DALAM callback — bukan di baris data.
 */
import { describe, expect, it } from "vitest";
import { parseDuration } from "./duration.js";
describe("A: typo pada field throws", () => {
  it.each([
    { case: "menit", input: "45m", expected: 45 * 60_000 },
    { case: "kosong ditolak", input: "", throw: /invalid duration/ },
  ])("$case", (row) => {
    if ("throws" in row) {
      expect(() => parseDuration(row.input)).toThrow(row.throws);
      return;
    }
    expect(parseDuration(row.input)).toBe(row.expected);
  });
});
