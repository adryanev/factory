import { describe, expect, it } from "vitest";
import { computeCostUsd } from "../../src/domain/costs.js";

describe("computeCostUsd — the one place a price is ever multiplied (issue 12)", () => {
  it("computes cost_usd = (input×in_per_million + output×out_per_million) / 1e6, at the column's 6-decimal scale", () => {
    expect(computeCostUsd({ inputTokenUsdPerMillion: "3.000000", outputTokenUsdPerMillion: "15.000000" }, { input_tokens: 1_000_000, output_tokens: 0 })).toBe("3.000000");
    expect(computeCostUsd({ inputTokenUsdPerMillion: "3.000000", outputTokenUsdPerMillion: "15.000000" }, { input_tokens: 0, output_tokens: 100_000 })).toBe("1.500000");
    expect(computeCostUsd({ inputTokenUsdPerMillion: "3.000000", outputTokenUsdPerMillion: "15.000000" }, { input_tokens: 1_000, output_tokens: 500 })).toBe("0.010500");
  });

  it("treats the two token classes independently — a zero-token class contributes nothing", () => {
    expect(computeCostUsd({ inputTokenUsdPerMillion: "6.000000", outputTokenUsdPerMillion: "30.000000" }, { input_tokens: 1_000_000, output_tokens: 0 })).toBe("6.000000");
    expect(computeCostUsd({ inputTokenUsdPerMillion: "6.000000", outputTokenUsdPerMillion: "30.000000" }, { input_tokens: 0, output_tokens: 1_000_000 })).toBe("30.000000");
  });

  it("never rounds below the stored scale — a display multiplies nothing", () => {
    const cost = computeCostUsd({ inputTokenUsdPerMillion: "3.000000", outputTokenUsdPerMillion: "15.000000" }, { input_tokens: 1, output_tokens: 1 });
    expect(cost).toBe("0.000018");
    expect(cost).toMatch(/^\d+\.\d{6}$/);
  });
});
