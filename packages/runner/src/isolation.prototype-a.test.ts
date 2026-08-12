/**
 * Varian A atas fungsi async yang mengembalikan `void`. Bentuk final #50:
 * baris sukses TIDAK membawa `expected` sama sekali, dan cabang suksesnya
 * tidak membaca field apa pun dari baris. Union barisnya karena itu
 * `{ case; readable }` | `{ case; readable; throws }`.
 *
 * Panggilan sengaja TIDAK dihoist ke atas cabang: hoisting benar untuk
 * async dan salah untuk sync, jadi satu aturan berlaku untuk keduanya.
 *
 * Baris terakhir sengaja merah.
 */
import { describe, expect, it } from "vitest";
import { verifyIsolation, type IsolationProbe } from "./isolation.js";

function probeReturning(readable: boolean): IsolationProbe {
  return { canAgentUserRead: async () => readable };
}

const IDENTITY_FILE = "/run/factory/runner.secret";

describe("verifyIsolation — varian A async void", () => {
  it.each([
    { case: "agent user tidak bisa membaca identity file", readable: false },
    { case: "agent user BISA membaca identity file", readable: true, throws: /agent user can read/ },
    { case: "baris merah sengaja", readable: true, throws: /tidak akan cocok/ },
  ])("$case", async (row) => {
    if ("throws" in row) {
      await expect(verifyIsolation(IDENTITY_FILE, probeReturning(row.readable))).rejects.toThrow(row.throws);
      return;
    }
    await expect(verifyIsolation(IDENTITY_FILE, probeReturning(row.readable))).resolves.toBeUndefined();
  });
});
