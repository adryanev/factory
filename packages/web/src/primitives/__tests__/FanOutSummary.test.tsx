import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FanOutSummary } from "../FanOutSummary";
import type { FanOutBranch } from "../fanOut";

function branches(n: number): FanOutBranch[] {
  return Array.from({ length: n }, (_, i) => ({
    key: `agent-${i}`,
    status: "succeeded" as const,
  }));
}

describe("FanOutSummary", () => {
  it("shows every branch and no remainder row at or below 8 branches", () => {
    render(<FanOutSummary stepLabel="implement" branches={branches(8)} />);
    expect(screen.getAllByRole("button", { name: /agent-/ })).toHaveLength(8);
    expect(screen.queryByText(/cabang lain/)).not.toBeInTheDocument();
  });

  it("shows a remainder row above 8 branches, naming the hidden count", () => {
    render(<FanOutSummary stepLabel="implement" branches={branches(50)} />);
    expect(screen.getAllByRole("button", { name: /agent-/ })).toHaveLength(8);
    expect(screen.getByText("…42 cabang lain")).toBeInTheDocument();
  });

  it("calls onSelectBranch with the Key, not an index", async () => {
    const onSelectBranch = vi.fn();
    const user = userEvent.setup();
    render(
      <FanOutSummary
        stepLabel="implement"
        branches={[{ key: "agent-b", status: "running" }]}
        onSelectBranch={onSelectBranch}
      />,
    );
    await user.click(screen.getByRole("button", { name: /agent-b/ }));
    expect(onSelectBranch).toHaveBeenCalledWith("agent-b");
  });

  it("calls onShowRemainder with the hidden count when the remainder row is clicked", async () => {
    const onShowRemainder = vi.fn();
    const user = userEvent.setup();
    render(
      <FanOutSummary
        stepLabel="implement"
        branches={branches(10)}
        onShowRemainder={onShowRemainder}
      />,
    );
    await user.click(screen.getByText("…2 cabang lain"));
    expect(onShowRemainder).toHaveBeenCalledWith(2);
  });
});
