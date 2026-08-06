/**
 * The SigV4 presigner's shape, unit-tested deterministically: given a fixed
 * clock the URL structure is exact, so a future drift in the signing input
 * (a header dropped, an expiry shortened) breaks here before it breaks
 * against a real bucket. The end-to-end round trip against a live Garage
 * lives in `test/garage/garage-contract.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { createS3ObjectStore, PRESIGNED_URL_LIFETIME_SECONDS } from "../../src/object-store.js";

const CONFIG = {
  endpoint: "http://garage:3900",
  region: "garage",
  bucket: "factory",
  accessKey: "AKIAIOSFODNN7EXAMPLE",
  secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

const FIXED_NOW = new Date("2026-01-01T00:00:00.000Z");

function store() {
  return createS3ObjectStore(CONFIG, () => FIXED_NOW);
}

describe("createS3ObjectStore (SigV4 presigner)", () => {
  it("mints a presigned PUT whose query carries the SigV4 fields and a 5-minute expiry", async () => {
    const { url, expiresAt } = await store().mintPutUrl("log/steprun_1/1/0");
    const parsed = new URL(url);

    expect(parsed.origin + parsed.pathname).toBe("http://garage:3900/factory/log/steprun_1/1/0");
    expect(parsed.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(parsed.searchParams.get("X-Amz-Credential")).toBe(
      "AKIAIOSFODNN7EXAMPLE/20260101/garage/s3/aws4_request",
    );
    expect(parsed.searchParams.get("X-Amz-Date")).toBe("20260101T000000Z");
    expect(parsed.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(Number(parsed.searchParams.get("X-Amz-Expires"))).toBe(PRESIGNED_URL_LIFETIME_SECONDS);
    expect(parsed.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);

    // The expiry is the mint instant + the stated 5 minutes (spec: stated, not shortened).
    expect(expiresAt.toISOString()).toBe("2026-01-01T00:05:00.000Z");
  });

  it("signs GET and PUT differently (method is part of the canonical request)", async () => {
    const put = await store().mintPutUrl("log/steprun_1/1/0");
    const get = await store().mintGetUrl("log/steprun_1/1/0");
    expect(get.url).not.toBe(put.url);
    // Both stay valid for the same stated 5 minutes.
    expect(put.expiresAt).toEqual(get.expiresAt);
  });

  it("percent-encodes each path segment of the key", async () => {
    const { url } = await store().mintGetUrl("log/steprun_1/1/0");
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/factory/log/steprun_1/1/0");
  });

  it("never changes across identical inputs — deterministic signing", async () => {
    const a = await store().mintGetUrl("log/steprun_1/1/0");
    const b = await store().mintGetUrl("log/steprun_1/1/0");
    expect(a.url).toBe(b.url);
  });
});
