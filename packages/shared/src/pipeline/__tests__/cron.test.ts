import { describe, expect, it } from "vitest";
import { cronMatches, isValidCronExpression } from "../cron.js";

describe("isValidCronExpression", () => {
  it("accepts the canonical 5-field shapes", () => {
    expect(isValidCronExpression("* * * * *")).toBe(true);
    expect(isValidCronExpression("0 3 * * *")).toBe(true);
    expect(isValidCronExpression("*/15 * * * *")).toBe(true);
    expect(isValidCronExpression("0 9-17 * * 1-5")).toBe(true);
    expect(isValidCronExpression("30 6,18 * * 0,6")).toBe(true);
    expect(isValidCronExpression("0 0 1 * *")).toBe(true);
  });

  it("rejects wrong field counts and out-of-range values", () => {
    expect(isValidCronExpression("* * * *")).toBe(false);
    expect(isValidCronExpression("* * * * * *")).toBe(false);
    expect(isValidCronExpression("60 * * * *")).toBe(false);
    expect(isValidCronExpression("* 24 * * *")).toBe(false);
    expect(isValidCronExpression("* * 32 * *")).toBe(false);
    expect(isValidCronExpression("* * * 13 *")).toBe(false);
    expect(isValidCronExpression("* * * * 7")).toBe(false);
    expect(isValidCronExpression("* * * *")).toBe(false);
    expect(isValidCronExpression("hello world foo bar baz")).toBe(false);
    expect(isValidCronExpression("* * * * * ")).toBe(false);
    expect(isValidCronExpression("*/0 * * * *")).toBe(false);
  });
});

describe("cronMatches", () => {
  const at = (iso: string): Date => new Date(iso);

  it("matches the minute field", () => {
    expect(cronMatches("*/5 * * * *", at("2026-01-01T00:05:00.000Z"))).toBe(true);
    expect(cronMatches("*/5 * * * *", at("2026-01-01T00:06:00.000Z"))).toBe(false);
  });

  it("matches the hour and the hour+minute combination", () => {
    expect(cronMatches("0 3 * * *", at("2026-01-01T03:00:00.000Z"))).toBe(true);
    expect(cronMatches("0 3 * * *", at("2026-01-01T03:01:00.000Z"))).toBe(false);
    expect(cronMatches("0 3 * * *", at("2026-01-01T02:00:00.000Z"))).toBe(false);
  });

  it("matches month and day-of-week", () => {
    // 2026-01-01 is a Thursday (dow 4); 2026-01-05 is a Monday (dow 1).
    expect(cronMatches("0 0 * 1 *", at("2026-01-15T00:00:00.000Z"))).toBe(true);
    expect(cronMatches("0 0 * 2 *", at("2026-01-15T00:00:00.000Z"))).toBe(false);
    expect(cronMatches("0 0 * * 1", at("2026-01-05T00:00:00.000Z"))).toBe(true);
    expect(cronMatches("0 0 * * 1", at("2026-01-01T00:00:00.000Z"))).toBe(false);
  });

  it("ORs concrete day-of-month with concrete day-of-week, cron style", () => {
    // Fires on the 1st of any month, or any Monday — 2026-01-01 is both.
    expect(cronMatches("0 0 1 * 1", at("2026-01-01T00:00:00.000Z"))).toBe(true);
    // A Monday that is not the 1st (2026-01-05) still fires via dow.
    expect(cronMatches("0 0 1 * 1", at("2026-01-05T00:00:00.000Z"))).toBe(true);
    // A Tuesday that is not the 1st (2026-01-06) does not fire.
    expect(cronMatches("0 0 1 * 1", at("2026-01-06T00:00:00.000Z"))).toBe(false);
  });

  it("supports ranges with steps and comma lists", () => {
    expect(cronMatches("0 9-17 * * *", at("2026-01-01T12:00:00.000Z"))).toBe(true);
    expect(cronMatches("0 9-17 * * *", at("2026-01-01T08:00:00.000Z"))).toBe(false);
    expect(cronMatches("0 6,18 * * *", at("2026-01-01T18:00:00.000Z"))).toBe(true);
    expect(cronMatches("0 6,18 * * *", at("2026-01-01T12:00:00.000Z"))).toBe(false);
  });
});
