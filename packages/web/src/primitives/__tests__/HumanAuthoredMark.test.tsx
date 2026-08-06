import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { HumanAuthoredMark } from "../HumanAuthoredMark";

describe("HumanAuthoredMark", () => {
  it("defaults to a generic human-authorship label", () => {
    render(<HumanAuthoredMark />);
    expect(screen.getByRole("note").textContent).toBe("ditulis manusia");
  });

  it("attributes the mark to the Principal who wrote it, when given", () => {
    render(<HumanAuthoredMark by="rangga" />);
    expect(screen.getByRole("note").textContent).toBe("ditulis rangga");
  });

  it("lets a caller supply custom copy without changing the semantic role", () => {
    render(<HumanAuthoredMark>edit-artifact</HumanAuthoredMark>);
    expect(screen.getByRole("note").textContent).toBe("edit-artifact");
  });
});
