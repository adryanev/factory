import { describe, expect, it } from "vitest";
import { parseDuration } from "../duration.js";

describe("parseDuration", () => {
  it("parses every supported unit into milliseconds", () => {
    expect(parseDuration("60ms")).toBe(60);
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("45m")).toBe(45 * 60_000);
    expect(parseDuration("2h")).toBe(2 * 3_600_000);
    expect(parseDuration("7d")).toBe(7 * 86_400_000);
  });

  it("accepts multi-digit amounts", () => {
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("120h")).toBe(120 * 3_600_000);
  });

  it("rejects anything the schema's pattern rejects", () => {
    for (const bad of ["", "0h", "2", "2H", "2 hours", "h", "1.5h", "1d2h"]) {
      expect(() => parseDuration(bad)).toThrow(/invalid duration/);
    }
  });
});
