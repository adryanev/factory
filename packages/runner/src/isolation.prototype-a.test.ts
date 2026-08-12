/**
 * Varian A atas fungsi async: apakah `throws` + narrowing bekerja lewat
 * `rejects`. Baris terakhir sengaja merah.
 */
import { describe, expect, it } from "vitest";
import { verifyIsolation, type IsolationProbe } from "./isolation.js";

function probeReturning(readable: boolean): IsolationProbe {
  return { canAgentUserRead: async () => readable };
}

describe("verifyIsolation — varian A async", () => {
  it.each([
    { case: "agent user tidak bisa membaca identity file", readable: false, expected: undefined },
    { case: "agent user BISA membaca identity file", readable: true, throws: /agent user can read/ },
    { case: "baris merah sengaja", readable: true, throws: /tidak akan cocok/ },
  ])("$case", async (row) => {
    const call = verifyIsolation("/run/factory/runner.secret", probeReturning(row.readable));
    if ("throws" in row) {
      await expect(call).rejects.toThrow(row.throws);
      return;
    }
    await expect(call).resolves.toBe(row.expected);
  });
});
