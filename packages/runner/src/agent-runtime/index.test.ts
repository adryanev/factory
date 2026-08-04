import { describe, expect, it } from "vitest";
import { startTurn } from "./index.js";

describe("agent-runtime fake seam", () => {
  it("startTurn reports success immediately, with no real agent invoked", async () => {
    const turn = startTurn({ prompt: "do the thing", workingDirectory: "/tmp/whatever" });
    const result = await turn.done;
    expect(result).toEqual({ stdout: "" });
  });

  it("cancel() before completion makes done reject instead of silently resolving success", async () => {
    const turn = startTurn({ prompt: "do the thing", workingDirectory: "/tmp/whatever" });
    turn.cancel();
    await expect(turn.done).rejects.toThrow(/cancelled/);
  });
});
