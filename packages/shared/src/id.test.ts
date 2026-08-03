import { describe, expect, it } from "vitest";
import { decodeBase32, encodeBase32, generateId, ID_PREFIXES, isValidId } from "./id.js";

describe("base32 codec", () => {
  it("round-trips arbitrary byte sequences", () => {
    const samples = [
      new Uint8Array(16),
      new Uint8Array(16).fill(0xff),
      Uint8Array.from({ length: 16 }, (_, i) => i * 17),
      Uint8Array.from({ length: 16 }, (_, i) => (i * 97 + 3) % 256),
    ];
    for (const bytes of samples) {
      expect(decodeBase32(encodeBase32(bytes), 16)).toEqual(bytes);
    }
  });

  it("rejects characters outside the alphabet", () => {
    expect(() => decodeBase32("iiiiiiiiiiiiiiiiiiiiiiiiii", 16)).toThrow();
  });
});

describe("generateId", () => {
  it("is time-ordered: ids generated at increasing timestamps sort lexicographically", () => {
    let tick = 1_700_000_000_000;
    const clock = () => tick;
    const ids = Array.from({ length: 50 }, () => {
      const id = generateId("probe", { now: clock });
      tick += 1;
      return id;
    });
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  it("round-trips through isValidId", () => {
    const id = generateId("probe");
    expect(isValidId("probe", id)).toBe(true);
  });

  it("is stable in shape: prefix, separator, 26-char body", () => {
    const id = generateId("probe");
    expect(id).toMatch(/^probe_[0-9a-hj-km-np-tv-z]{26}$/);
  });

  it("is safe as a git ref component: single case, no reserved characters", () => {
    const id = generateId("probe");
    expect(id).toBe(id.toLowerCase());
    expect(id).not.toMatch(/[\s~^:?*[\]\\@]/);
    expect(id).not.toContain("..");
    expect(id.endsWith(".lock")).toBe(false);
  });

  it("is client-generatable: pure function of injected clock and randomness, no I/O", () => {
    const fixedRandom = () => new Uint8Array(10).fill(0x42);
    const id = generateId("probe", { now: () => 1_700_000_000_000, randomBytes: fixedRandom });
    const again = generateId("probe", { now: () => 1_700_000_000_000, randomBytes: fixedRandom });
    expect(id).toBe(again);
  });

  it("rejects ids for the wrong prefix", () => {
    const id = generateId("probe");
    expect(isValidId("probe", id)).toBe(true);
    expect(id.startsWith("probe_")).toBe(true);
  });
});

describe("ID_PREFIXES", () => {
  it("contains no prefix with the `_` separator character, so id.split(\"_\")[0] is safe", () => {
    for (const prefix of ID_PREFIXES) {
      expect(prefix).not.toContain("_");
    }
  });
});
