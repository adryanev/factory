import { describe, expect, it } from "vitest";
import { stepRunBranchName } from "../step-run-branch.js";

describe("stepRunBranchName", () => {
  it("builds the no-Key form verbatim: run/<run-id>/<step-key>/t<turn>-a<attempt>", () => {
    expect(
      stepRunBranchName({ runId: "run_0001", stepKey: "implement", branchKey: null, turn: 1, attempt: 1 }),
    ).toBe("run/run_0001/implement/t1-a1");
  });

  it("inserts the branch-key segment for a fan-out Step", () => {
    expect(
      stepRunBranchName({
        runId: "run_0001",
        stepKey: "implement",
        branchKey: "agent-b",
        turn: 2,
        attempt: 3,
      }),
    ).toBe("run/run_0001/implement/agent-b/t2-a3");
  });

  it("keeps the turn/attempt suffix parseable even when the attempt grows to two digits", () => {
    const name = stepRunBranchName({
      runId: "run_0001",
      stepKey: "test",
      branchKey: null,
      turn: 12,
      attempt: 10,
    });
    expect(name).toMatch(/\/t12-a10$/);
    expect(name).toBe("run/run_0001/test/t12-a10");
  });

  it("distinguishes a Key'd branch from a no-Key branch of the same step", () => {
    const withKey = stepRunBranchName({
      runId: "run_0001",
      stepKey: "implement",
      branchKey: "agent-a",
      turn: 1,
      attempt: 1,
    });
    const withoutKey = stepRunBranchName({
      runId: "run_0001",
      stepKey: "implement",
      branchKey: null,
      turn: 1,
      attempt: 1,
    });
    expect(withKey).not.toBe(withoutKey);
  });
});
