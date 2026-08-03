import { describe, expect, it } from "vitest";
import { formatTurnForBranchName, formatTurnLong } from "../turnNotation";

describe("turnNotation", () => {
  it("writes the long form out in full, exactly as locked in spec.md", () => {
    expect(formatTurnLong({ turn: 4, attempt: 1 })).toBe(
      "giliran 4 · attempt 1",
    );
  });

  it("writes the branch-name form as the literal t<turn>-a<attempt> token", () => {
    expect(formatTurnForBranchName({ turn: 4, attempt: 1 })).toBe("t4-a1");
  });

  it("the two forms never coincide, even for the same turn/attempt pair", () => {
    const pair = { turn: 12, attempt: 3 };
    expect(formatTurnLong(pair)).not.toBe(formatTurnForBranchName(pair));
  });

  it("distinguishes a retried attempt in both forms", () => {
    expect(formatTurnLong({ turn: 1, attempt: 2 })).toBe(
      "giliran 1 · attempt 2",
    );
    expect(formatTurnForBranchName({ turn: 1, attempt: 2 })).toBe("t1-a2");
  });
});
