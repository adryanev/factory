import { describe, expect, it } from "vitest";
import { parseDuration } from "../duration.js";

type ParseDurationCase =
  | { case: string; input: string; expected: number; throws?: never }
  | { case: string; input: string; throws: RegExp; expected?: never };

describe("parseDuration", () => {
  // lewati: separator — DURATION_PATTERN di duration.ts:8 tidak punya separator
  // lewati: panjang — DURATION_PATTERN tidak punya batas panjang
  it.each([
    { case: "unit ms", input: "60ms", expected: 60 },
    { case: "unit s", input: "30s", expected: 30_000 },
    { case: "unit m", input: "45m", expected: 45 * 60_000 },
    { case: "unit h", input: "2h", expected: 2 * 3_600_000 },
    { case: "unit d", input: "7d", expected: 7 * 86_400_000 },
    { case: "amount berdigit banyak", input: "500ms", expected: 500 },
    { case: "amount berdigit banyak, unit terpanjang", input: "120h", expected: 120 * 3_600_000 },
    { case: "kosong", input: "", throws: /invalid duration/ },
    { case: "hanya whitespace", input: "   ", throws: /invalid duration/ },
    { case: "unit huruf besar", input: "2H", throws: /invalid duration/ },
    { case: "amount berawalan nol", input: "0h", throws: /invalid duration/ },
    { case: "tanpa unit", input: "2", throws: /invalid duration/ },
    { case: "tanpa amount", input: "h", throws: /invalid duration/ },
    { case: "unit dieja penuh, dengan spasi", input: "2 hours", throws: /invalid duration/ },
    { case: "amount pecahan", input: "1.5h", throws: /invalid duration/ },
    { case: "dua pasang amount-unit", input: "1d2h", throws: /invalid duration/ },
  ] satisfies ParseDurationCase[])("$case", (row) => {
    if ("throws" in row) {
      expect(() => parseDuration(row.input)).toThrow(row.throws);
      return;
    }
    expect(parseDuration(row.input)).toBe(row.expected);
  });
});
