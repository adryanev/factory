/**
 * PROBE #50 — kegagalan `tsc --noEmit` ADALAH temuannya.
 * Varian A, satu baris lupa field hasil sama sekali. Harapan: tsc menolak.
 */
import { describe, expect, it } from "vitest";
import { parseDuration } from "./duration.js";
describe("A: baris lupa field hasil", () => {
  it.each([
    { case: "menit", input: "45m", expected: 45 * 60_000 },
    { case: "lupa hasil", input: "2h" },
  ])("$case", (row) => {
    if ("throws" in row) {
      expect(() => parseDuration(row.input)).toThrow(row.throws);
      return;
    }
    expect(parseDuration(row.input)).toBe(row.expected);
  });
});
