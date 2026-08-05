import { describe, expect, it } from "vitest";
import { IsolationVerificationError, verifyIsolation, type IsolationProbe } from "./isolation.js";

function probeReturning(readable: boolean): IsolationProbe {
  return { canAgentUserRead: async () => readable };
}

describe("verifyIsolation", () => {
  it("passes when the agent user cannot read the identity file", async () => {
    await expect(verifyIsolation("/run/factory/runner.secret", probeReturning(false))).resolves.toBeUndefined();
  });

  it("throws with an operator-actionable message when the agent user CAN read the identity file", async () => {
    await expect(verifyIsolation("/run/factory/runner.secret", probeReturning(true))).rejects.toThrow(
      IsolationVerificationError,
    );
    await expect(verifyIsolation("/run/factory/runner.secret", probeReturning(true))).rejects.toThrow(
      /agent user can read/,
    );
  });
});
