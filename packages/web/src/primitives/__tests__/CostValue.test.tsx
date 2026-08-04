import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CostValue } from "../CostValue";
import { COST_UNSUPPORTED_LABEL } from "../../cost/format";

describe("CostValue — the 'tidak didukung, never an estimate' rule (issue 12, AC1)", () => {
  it("renders the words 'tidak didukung' when the agent reported no usage — never a number", () => {
    const { container } = render(<CostValue supported={false} costUsd={null} />);
    expect(screen.getByText(COST_UNSUPPORTED_LABEL)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\$|\d/);
  });

  it("renders the stored figure when the usage was priced", () => {
    render(<CostValue supported={true} costUsd="3.000000" tokens={{ inputTokens: 1_000_000, outputTokens: 0 }} />);
    expect(screen.getByText("$3.00")).toBeInTheDocument();
  });

  it("shows the token counts that produced the figure, when reported", () => {
    render(<CostValue supported={true} costUsd="0.010500" tokens={{ inputTokens: 1_000, outputTokens: 500 }} />);
    expect(screen.getByText("$0.01")).toBeInTheDocument();
    expect(screen.getByText(/1,000 in · 500 out/)).toBeInTheDocument();
  });

  it("keeps sub-cent priced amounts readable — a real tiny cost never reads as a rounded zero", () => {
    render(<CostValue supported={true} costUsd="0.000018" tokens={{ inputTokens: 1, outputTokens: 1 }} />);
    expect(screen.getByText("$0.000018")).toBeInTheDocument();
  });
});
