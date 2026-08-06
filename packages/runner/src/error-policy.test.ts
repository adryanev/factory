/**
 * AC9: "Hanya `401` yang membuat Runner berhenti; `426`/`409`/`400`/`413`/
 * `429`/`503`/`5xx` semuanya membiarkan ia tetap heartbeat dan kembali ke
 * `/claim`." Every status the spec's error table names, exercised
 * individually — not just "401 stops, everything else is lumped together" —
 * so a future edit that special-cases one of them can't slip past a test
 * that never actually asked about it.
 */
import { describe, expect, it } from "vitest";
import { decideOnStatus } from "./error-policy.js";

describe("decideOnStatus", () => {
  it("401 (bad or revoked secret) is the only status that stops the Runner", () => {
    expect(decideOnStatus(401)).toBe("stop");
  });

  it.each([426, 409, 400, 422, 413, 429, 503, 500, 502, 504])(
    "%i leaves the Runner heartbeating and returning to /claim",
    (status) => {
      expect(decideOnStatus(status)).toBe("continue");
    },
  );

  it("2xx success also continues, trivially", () => {
    expect(decideOnStatus(200)).toBe("continue");
  });
});
