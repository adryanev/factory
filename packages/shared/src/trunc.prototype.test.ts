import { describe, expect, it } from "vitest";
describe("t", () => {
  it.each([
    { case: "x".repeat(30), n: 1 },
    { case: "y".repeat(35), n: 1 },
    { case: "z".repeat(38), n: 1 },
    { case: "w".repeat(40), n: 1 },
    { case: "v".repeat(50), n: 1 },
  ])("$case", ({ n }) => { expect(n).toBe(2); });
});
