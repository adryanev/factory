// Pure functions, vitest only — no React, no jsdom needed: fanOut.ts is pure logic.
import { describe, expect, it } from "vitest";
import {
  classifyBranch,
  summarizeFanOut,
  FAN_OUT_SUMMARY_THRESHOLD,
  type FanOutBranch,
} from "../fanOut";

function branch(
  key: string,
  status: FanOutBranch["status"],
  unscheduledOverThreshold = false,
): FanOutBranch {
  return { key, status, unscheduledOverThreshold };
}

describe("classifyBranch", () => {
  it("buckets a ready-but-unscheduled branch as unsched, not ready", () => {
    expect(
      classifyBranch(branch("agent-a", "ready", true)),
    ).toBe("unsched");
  });

  it("buckets an ordinary ready branch as rest", () => {
    expect(classifyBranch(branch("agent-a", "ready", false))).toBe("rest");
  });

  it("buckets succeeded, skipped and cancelled as rest", () => {
    expect(classifyBranch(branch("a", "succeeded"))).toBe("rest");
    expect(classifyBranch(branch("a", "skipped"))).toBe("rest");
    expect(classifyBranch(branch("a", "cancelled"))).toBe("rest");
  });
});

describe("summarizeFanOut", () => {
  it("does not summarize at or below the 8-branch threshold", () => {
    const branches = Array.from({ length: FAN_OUT_SUMMARY_THRESHOLD }, (_, i) =>
      branch(`b${i}`, "succeeded"),
    );
    const result = summarizeFanOut(branches);
    expect(result.isSummarized).toBe(false);
    expect(result.hiddenCount).toBe(0);
    expect(result.shown).toHaveLength(FAN_OUT_SUMMARY_THRESHOLD);
  });

  it("summarizes above 8 branches, hiding the rest behind a count", () => {
    const branches = Array.from({ length: 42 }, (_, i) =>
      branch(`b${i}`, "succeeded"),
    );
    const result = summarizeFanOut(branches);
    expect(result.isSummarized).toBe(true);
    expect(result.shown).toHaveLength(FAN_OUT_SUMMARY_THRESHOLD);
    expect(result.hiddenCount).toBe(42 - FAN_OUT_SUMMARY_THRESHOLD);
  });

  it("orders failed before awaiting-human before unsched before running before the rest — the one broken branch must never hide behind forty healthy ones", () => {
    const branches: FanOutBranch[] = [
      ...Array.from({ length: 40 }, (_, i) => branch(`healthy-${i}`, "succeeded")),
      branch("the-broken-one", "failed"),
      branch("waiting-on-human", "awaiting-human"),
      branch("no-runner", "ready", true),
      branch("still-going", "running"),
    ];
    const { shown } = summarizeFanOut(branches);
    expect(shown.map((b) => b.key)).toEqual([
      "the-broken-one",
      "waiting-on-human",
      "no-runner",
      "still-going",
      "healthy-0",
      "healthy-1",
      "healthy-2",
      "healthy-3",
    ]);
  });

  it("keeps input order stable within a bucket", () => {
    const branches = [
      branch("agent-c", "failed"),
      branch("agent-a", "failed"),
      branch("agent-b", "failed"),
    ];
    const { shown } = summarizeFanOut(branches);
    expect(shown.map((b) => b.key)).toEqual(["agent-c", "agent-a", "agent-b"]);
  });
});
