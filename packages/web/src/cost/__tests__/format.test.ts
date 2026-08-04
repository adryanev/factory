import { describe, expect, it } from "vitest";
import {
  COST_LOWER_BOUND_NOTE,
  COST_RUNNING_LABEL,
  COST_UNSUPPORTED_LABEL,
  formatUsd,
} from "../format";

describe("formatUsd — renders the stored figure, never a recomputed one (issue 12)", () => {
  it("formats stored numeric strings at two decimals", () => {
    expect(formatUsd("3.000000")).toBe("$3.00");
    expect(formatUsd("0.010500")).toBe("$0.01");
    expect(formatUsd("9.000000")).toBe("$9.00");
  });

  it("keeps sub-cent priced amounts at the stored 6-decimal precision", () => {
    expect(formatUsd("0.000018")).toBe("$0.000018");
  });

  it("keeps null as null — the caller decides the 'tidak didukung' wording", () => {
    expect(formatUsd(null)).toBeNull();
  });
});

describe("the cost display vocabulary is words, not symbols", () => {
  it("spells out the two rules this issue exists for", () => {
    expect(COST_UNSUPPORTED_LABEL).toBe("tidak didukung");
    expect(COST_LOWER_BOUND_NOTE).toBe("Batas bawah, bukan total");
    expect(COST_RUNNING_LABEL).toBe("Biaya berjalan");
  });
});
