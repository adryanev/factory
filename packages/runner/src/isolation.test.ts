import { describe, expect, it } from "vitest";
import { verifyIsolation, type IsolationProbe } from "./isolation.js";

type VerifyIsolationCase = {
  case: string;
  readable: boolean;
  throws?: RegExp;
};

function probe(readable: boolean): IsolationProbe {
  return { canAgentUserRead: async () => readable };
}

describe("verifyIsolation", () => {
  it.each([
    {
      case: "lulus saat agent user tidak bisa membaca file identitas",
      readable: false,
    },
    {
      case: "melempar saat agent user bisa membaca file identitas",
      readable: true,
      throws: /agent user can read/,
    },
  ] satisfies VerifyIsolationCase[])("$case", async (row) => {
    if ("throws" in row) {
      await expect(verifyIsolation("/run/factory/runner.secret", probe(row.readable))).rejects.toThrow(row.throws);
      return;
    }
    await expect(verifyIsolation("/run/factory/runner.secret", probe(row.readable))).resolves.toBeUndefined();
  });
});
