import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { RunCost } from "../RunCost";
import { COST_RUNNING_LABEL } from "../../cost/format";
import type { RunCostData } from "../../cost/types";

describe("RunCost — the running cost on the cancel-button screen (issue 12, AC8)", () => {
  const inFlight: RunCostData = {
    totalCostUsd: "3.000000",
    supportedAttempts: 1,
    unsupportedAttempts: 0,
    credentialPrincipalId: "serviceaccount_x",
    runEnded: false,
  };

  it("labels the figure as 'Biaya berjalan' while the Run is in flight", () => {
    render(<RunCost data={inFlight} />);
    expect(screen.getByText(COST_RUNNING_LABEL)).toBeInTheDocument();
    expect(screen.getByText("$3.00")).toBeInTheDocument();
  });

  it("renders a plain total once the Run has ended", () => {
    render(<RunCost data={{ ...inFlight, runEnded: true, unsupportedAttempts: 2 }} />);
    expect(screen.queryByText(COST_RUNNING_LABEL)).not.toBeInTheDocument();
    expect(screen.getByText("total")).toBeInTheDocument();
    expect(screen.getByText(/2 attempt tanpa laporan pemakaian/)).toBeInTheDocument();
  });

  it("never guesses a figure when nothing has been priced yet", () => {
    render(<RunCost data={{ ...inFlight, totalCostUsd: null }} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
