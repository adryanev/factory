import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { StepRunCost } from "../StepRunCost";
import { COST_UNSUPPORTED_LABEL } from "../../cost/format";
import type { StepRunCostData } from "../../cost/types";

describe("StepRunCost — the per-attempt breakdown (issue 12, AC6)", () => {
  const data: StepRunCostData = {
    totalCostUsd: "1.500000",
    attempts: [
      { attempt: 1, supported: false, tokens: null, costUsd: null, priceVersion: null },
      { attempt: 2, supported: true, tokens: { inputTokens: 500_000, outputTokens: 0 }, costUsd: "1.500000", priceVersion: "v1" },
    ],
  };

  it("renders one row per attempt — including the unsupported one — and the summed total", () => {
    render(<StepRunCost data={data} />);
    expect(screen.getByText("attempt 1")).toBeInTheDocument();
    expect(screen.getByText("attempt 2")).toBeInTheDocument();
    expect(screen.getAllByText("$1.50")).toHaveLength(2); // attempt 2's row + the total
    expect(screen.getByText(COST_UNSUPPORTED_LABEL)).toBeInTheDocument();
  });

  it("keeps the unsupported attempt visible so a repeatedly-failing StepRun is investigable", () => {
    render(<StepRunCost data={data} />);
    expect(screen.getByText("attempt 1").nextElementSibling).toHaveTextContent(COST_UNSUPPORTED_LABEL);
  });
});
