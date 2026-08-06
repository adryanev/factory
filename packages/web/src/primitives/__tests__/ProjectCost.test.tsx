import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProjectCost } from "../ProjectCost";
import { COST_LOWER_BOUND_NOTE } from "../../cost/format";
import type { ProjectCostData } from "../../cost/types";

describe("ProjectCost — the lower bound, stated in words (issue 12, AC2/AC9)", () => {
  const data: ProjectCostData = {
    totalCostUsd: "9.000000",
    lowerBound: true,
    byCredentialPrincipal: [
      { credentialPrincipalId: "serviceaccount_shared", costUsd: "6.000000" },
      { credentialPrincipalId: "user_adryan", costUsd: "3.000000" },
    ],
  };

  it("states the total's nature in full words — never a small footnote mark", () => {
    const { container } = render(<ProjectCost data={data} />);
    expect(screen.getByText(COST_LOWER_BOUND_NOTE)).toBeInTheDocument();
    expect(screen.getByText("$9.00")).toBeInTheDocument();
    expect(container.querySelector("sup, [aria-label]")).toBeNull();
  });

  it("breaks the total down by the credential principal each Run used", () => {
    render(<ProjectCost data={data} />);
    expect(screen.getByText("serviceaccount_shared")).toBeInTheDocument();
    expect(screen.getByText("$6.00")).toBeInTheDocument();
    expect(screen.getByText("user_adryan")).toBeInTheDocument();
    expect(screen.getByText("$3.00")).toBeInTheDocument();
  });

  it("renders a dash when no attempt has been priced yet — no estimate", () => {
    render(<ProjectCost data={{ ...data, totalCostUsd: null, byCredentialPrincipal: [] }} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
