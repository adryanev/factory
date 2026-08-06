import { describe, expect, it } from "vitest";
import { createLiteralRedactor, REDACTION_PLACEHOLDER } from "./redaction.js";

describe("createLiteralRedactor", () => {
  it("replaces exact literal occurrences of each secret", () => {
    const redact = createLiteralRedactor(["ghs_secret_token", "passw0rd"]);
    const out = redact("login with ghs_secret_token then passw0rd again");
    expect(out).toBe("login with [redacted] then [redacted] again");
  });

  it("replaces a secret that appears multiple times", () => {
    const redact = createLiteralRedactor(["abc123"]);
    expect(redact("abc123 abc 123 abc123")).toBe("[redacted] abc 123 [redacted]");
  });

  it("replaces a longer secret as one unit when a shorter one is also present", () => {
    const redact = createLiteralRedactor(["abc", "abcdefgh"]);
    expect(redact("abcdefgh")).toBe("[redacted]");
    expect(redact("abc")).toBe("[redacted]");
  });

  it("is best-effort: a substring-with-tampering secret is NOT redacted (no regex, no heuristics)", () => {
    const redact = createLiteralRedactor(["ghs_abc"]);
    // The newline-split secret escapes the literal match — this is the
    // documented, accepted limit of literal redaction.
    expect(redact("ghs_ab\nc")).toBe("ghs_ab\nc");
    expect(redact("ghs_abc")).toBe("[redacted]");
  });

  it("returns the identity function for an empty secret list", () => {
    const redact = createLiteralRedactor([]);
    expect(redact("anything at all")).toBe("anything at all");
  });

  it("ignores empty secret strings", () => {
    const redact = createLiteralRedactor([""]);
    expect(redact("text")).toBe("text");
  });

  it("uses the shared placeholder constant", () => {
    const redact = createLiteralRedactor(["secret"]);
    expect(redact("secret")).toBe(REDACTION_PLACEHOLDER);
  });
});
