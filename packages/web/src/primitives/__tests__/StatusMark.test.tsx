import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusMark } from "../StatusMark";
import { STEP_RUN_STATUSES } from "../../tokens/status";
import type { StepRunStatus } from "../../tokens/status";

/**
 * The rendered glyph geometry, not the `data-shape` attribute. `data-shape`
 * is written straight from StatusMark's internal SHAPE_BY_STATUS map, so
 * asserting on it only re-states that map — it stays "distinct" even if two
 * cases in the `Glyph` switch were edited to draw the same thing. This reads
 * what actually lands in the DOM instead: the second child of the <svg> (the
 * first is always the status ring, which carries no shape meaning of its
 * own — see StatusMark.tsx's DASHED_RING comment), or "no-glyph" for
 * `ready`, which deliberately renders none.
 */
function renderedGlyphSignature(status: StepRunStatus): string {
  const { container, unmount } = render(<StatusMark status={status} />);
  const svg = container.querySelector("svg");
  const glyph = svg?.children[1];
  const signature = glyph
    ? `${glyph.tagName}:${glyph.getAttribute("d") ?? ""}`
    : "no-glyph";
  unmount();
  return signature;
}

describe("StatusMark", () => {
  it("gives every StepRun status a distinct rendered glyph, independent of colour", () => {
    const signatures = STEP_RUN_STATUSES.map(renderedGlyphSignature);
    // One entry per status — no two statuses render the same glyph geometry.
    expect(new Set(signatures).size).toBe(STEP_RUN_STATUSES.length);
  });

  it("always exposes a non-empty, per-status accessible label (role=img + aria-label)", () => {
    const labels = STEP_RUN_STATUSES.map((status) => {
      const { unmount, getByRole } = render(<StatusMark status={status} />);
      const name = getByRole("img").getAttribute("aria-label");
      unmount();
      return name;
    });
    expect(labels.every((name) => !!name && name.length > 0)).toBe(true);
    // Duplicates would mean two statuses are indistinguishable by screen
    // reader too, not just by colour.
    expect(new Set(labels).size).toBe(STEP_RUN_STATUSES.length);
  });

  it("lets a caller override the label for i18n without changing the shape", () => {
    render(<StatusMark status="failed" label="Gagal" />);
    expect(screen.getByRole("img", { name: "Gagal" })).toBeInTheDocument();
  });

  it("marks failed and skipped with different glyphs — the pair issue 13 flags as most likely to be confused", () => {
    expect(renderedGlyphSignature("failed")).not.toBe(
      renderedGlyphSignature("skipped"),
    );
  });
});
