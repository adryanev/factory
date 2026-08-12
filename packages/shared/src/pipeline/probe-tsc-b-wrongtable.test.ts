/**
 * PROBE #50 — di sini `tsc --noEmit` LOLOS, dan ITULAH temuannya.
 * Varian B, baris melempar salah masuk tabel yang mengembalikan. Sebab:
 * inferensi menstempel `?: never`, jadi destructure `expected` menghasilkan
 * `number | undefined`, dan `toBe()` menerima `unknown`. Hanya tersingkap
 * dengan MENJALANKAN-nya.
 */
import { describe, expect, it } from "vitest";
import { parseDuration } from "./duration.js";
describe("B: baris melempar salah tabel", () => {
  it.each([
    { case: "menit", input: "45m", expected: 45 * 60_000 },
    { case: "kosong ditolak", input: "", message: /invalid duration/ },
  ])("$case", ({ input, expected }) => {
    expect(parseDuration(input)).toBe(expected);
  });
});
