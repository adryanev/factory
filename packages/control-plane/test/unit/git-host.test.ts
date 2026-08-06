/**
 * Unit tests for the GitHub App half of `GitHost` that needs no network: the
 * RS256 app JWT minted to authorize installation-token requests, and the
 * unconfigured-host guard. Everything that dials github.com is covered by the
 * fake in seam-1 instead — never tested here.
 */
import { describe, expect, it } from "vitest";
import { createGithubHost, retryAfterFrom, signGithubAppJwt } from "../../src/domain/git-host.js";

const PRIVATE_KEY = `-----BEGIN RSA PRIVATE KEY-----
MIIBOQIBAAJBAJtdPR5Kg9ShHyMrqSLcDUvxtADqsSJ6zh2SPfoKKGkPeYhQw/z0
P6io2zg+iN4s7EE35pAOCHPb2Ej/UKTEescCAwEAAQJAM3xEgsNCyLXUMb2IQUsX
BPHGKv+bT8fOgjIyY6f2GEpKTyFESsKQc3V0BuQzMfJ6FWHOiuPDfkHPyLoyUwPa
8QIhAMwL1mAuiYd6Qu2xV9v6ts3kAGHBv/TvuZBKQWTMS2eFAiEAwuw0YRJBYNwH
Td+iZsBcumJzqMXil/u81n/EgoWs/NsCIDXNtUR9YPRhT76fcbxmusdFpLgiP7yV
bcfXXLD4kbWFAiBICf4Nxi5tesQkTrt5mCxtIge233OwUfRnng7lYjwdswIgDVKA
WsProLT8UtyUK4gvfBd1A+torBt67hKT2qpUIyo=
-----END RSA PRIVATE KEY-----`;

describe("signGithubAppJwt", () => {
  it("produces a three-part RS256 JWT carrying the app id and a ≤10-minute lifetime", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const jwt = signGithubAppJwt(123456, PRIVATE_KEY, now);

    const [headerB64, payloadB64, signature] = jwt.split(".");
    expect(signature).toBeTruthy();

    const header = JSON.parse(Buffer.from(headerB64!, "base64url").toString("utf-8"));
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });

    const payload = JSON.parse(Buffer.from(payloadB64!, "base64url").toString("utf-8"));
    expect(payload.iss).toBe(123456);
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(600); // GitHub: JWT lifetime ≤ 10 minutes.
    expect(payload.exp - payload.iat).toBeGreaterThan(0);
  });

  it("the two mints of a turn get distinct lifetimes but the same issuer", () => {
    const jwt1 = signGithubAppJwt(7, PRIVATE_KEY, new Date("2026-01-01T00:00:00.000Z"));
    const jwt2 = signGithubAppJwt(7, PRIVATE_KEY, new Date("2026-01-01T00:00:30.000Z"));
    expect(jwt1).not.toBe(jwt2); // iat/exp differ by the 30s between the mints.
    const decode = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf-8"));
    expect(decode(jwt1).iss).toBe(decode(jwt2).iss);
  });
});

describe("createGithubHost", () => {
  it("minting without App credentials fails with a clear error instead of dialing github.com", async () => {
    const host = createGithubHost(); // no config — the read-only half.
    await expect(host.mintInstallationToken({ owner: "acme", name: "backend" }, 42)).rejects.toThrow(
      "github app credentials not configured",
    );
  });
});

describe("retryAfterFrom", () => {
  it("returns the Retry-After seconds GitHub sent, verbatim", () => {
    const response = new Response(null, { headers: { "retry-after": "120" } });
    expect(retryAfterFrom(response)).toBe(120);
  });

  it("returns null when GitHub sent no Retry-After header", () => {
    const response = new Response(null, { status: 500 });
    expect(retryAfterFrom(response)).toBeNull();
  });

  it("returns null for a header that is not a positive number", () => {
    expect(retryAfterFrom(new Response(null, { headers: { "retry-after": "later" } }))).toBeNull();
    expect(retryAfterFrom(new Response(null, { headers: { "retry-after": "-3" } }))).toBeNull();
  });
});
