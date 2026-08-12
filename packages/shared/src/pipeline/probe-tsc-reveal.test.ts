/**
 * PROBE #50 — kegagalan `tsc --noEmit` ADALAH temuannya: TS2322 mencetak
 * tipe baris yang diinferensi untuk bentuk A. Menunjukkan stempel `?: never`
 * pada arm komplementer, yang membuat `"throws" in row` menyempit bersih
 * tanpa anotasi apa pun.
 */
import { describe, it } from "vitest";
describe("reveal tipe baris varian A", () => {
  it.each([
    { case: "menit", input: "45m", expected: 45 * 60_000 },
    { case: "kosong ditolak", input: "", throws: /invalid duration/ },
  ])("$case", (row) => {
    const reveal: null = row;
    void reveal;
  });
});
