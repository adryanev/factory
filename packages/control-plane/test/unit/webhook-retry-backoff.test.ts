/**
 * The webhook-delivery sweep's retry schedule: 30s, doubling per failed
 * attempt, capped at an hour. The selection and dead-letter behaviour that
 * consumes this schedule is proven end-to-end in test/seam1/automation.test.ts;
 * this pins the one decision that is pure — how long to wait before the next
 * attempt — so it can be checked without a database or a clock.
 */
import { describe, expect, it } from "vitest";
import { webhookRetryBackoffMs } from "../../src/domain/automation/index.js";

describe("webhookRetryBackoffMs", () => {
  it("starts at 30 seconds after the first failed attempt", () => {
    expect(webhookRetryBackoffMs(1)).toBe(30_000);
  });

  it("doubles per attempt", () => {
    expect(webhookRetryBackoffMs(2)).toBe(60_000);
    expect(webhookRetryBackoffMs(3)).toBe(120_000);
    expect(webhookRetryBackoffMs(4)).toBe(240_000);
  });

  it("caps at one hour, however many attempts", () => {
    expect(webhookRetryBackoffMs(8)).toBe(60 * 60 * 1000); // 30s * 2^7 = 3840s, would exceed the cap uncapped.
    expect(webhookRetryBackoffMs(20)).toBe(60 * 60 * 1000);
  });
});
