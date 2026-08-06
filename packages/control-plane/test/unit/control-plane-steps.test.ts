/**
 * Pure-function tests for the control-plane Step executor's retry policy
 * (issue #17, AC2: "patuhi `Retry-After`"; backoff 5s fixed otherwise). The
 * transient-failure loop itself is proven end-to-end in
 * `test/seam1/control-plane-pull-request.test.ts`; this pins the one decision
 * that is pure — which backoff to sleep after a failed GitHub call.
 */
import { describe, expect, it } from "vitest";
import { retryBackoffMs } from "../../src/domain/control-plane-steps.js";
import { GithubRequestError } from "../../src/domain/git-host.js";

const FIXED_BACKOFF_MS = 5000;

describe("retryBackoffMs", () => {
  it("honors GitHub's Retry-After verbatim over the fixed backoff", () => {
    const error = new GithubRequestError("429", 429, 120);
    expect(retryBackoffMs(error, FIXED_BACKOFF_MS)).toBe(120_000);
  });

  it("falls back to the fixed 5s backoff when the failure carried no Retry-After", () => {
    const plain = new Error("boom");
    expect(retryBackoffMs(plain, FIXED_BACKOFF_MS)).toBe(FIXED_BACKOFF_MS);
    const noHeader = new GithubRequestError("500", 500, null);
    expect(retryBackoffMs(noHeader, FIXED_BACKOFF_MS)).toBe(FIXED_BACKOFF_MS);
  });
});
