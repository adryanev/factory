/**
 * The Runner's artifact uploader (issue #10): the order that makes the
 * artifact path honest — PUT the bytes to the object store first, then let
 * the successfully-uploaded subset ride `/result` (spec: "upload dulu →
 * catat metadata", AC4/AC5). One batch per call (AC2), and a failed PUT —
 * permanent or transient — simply drops that artifact from the list, never
 * failing the turn.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createProtocolArtifactUploader } from "../artifact-uploader.js";
import type { ProtocolClient, UploadGrant } from "../protocol/client.js";

function fakeProtocol(records: { key: string; kind: string; sizeBytes?: number }[] = []): {
  protocol: ProtocolClient;
  minted: { key: string; kind: string; sizeBytes?: number }[];
} {
  const minted = records;
  return {
    protocol: {
      async claim() {
        return null;
      },
      async heartbeat() {
        throw new Error("unused");
      },
      async reportResult() {
        throw new Error("unused");
      },
      async mintUploadGrants({ requests }) {
        minted.push(...requests);
        const grants: UploadGrant[] = requests.map((request) => ({
          key: request.key,
          uploadUrl: `https://blob.invalid/put/${request.key}`,
          expiresAt: "2026-01-01T00:05:00.000Z",
          blobKey: `artifact/steprun_1/${request.key}`,
        }));
        return grants;
      },
      async recordLogChunks() {
        throw new Error("unused");
      },
      async submitQuestion() {
        throw new Error("unused");
      },
      async reportCapabilities() {
        throw new Error("unused");
      },
      async drain() {
        throw new Error("unused");
      },
    },
    minted,
  };
}

describe("createProtocolArtifactUploader", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("mints the whole batch in one /uploads call with declared sizes, PUTs each, and returns exactly what rode up", async () => {
    const { protocol, minted } = fakeProtocol();
    const putBodies: { key: string; body: string }[] = [];
    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PUT") {
        // The uploader PUTs presigned string URLs with string bodies; assert
        // that invariant instead of stringifying whatever fetch handed us.
        if (typeof url !== "string") {
          throw new Error(`expected a string PUT url, got ${url.constructor.name}`);
        }
        if (typeof init.body !== "string") {
          throw new Error("expected a string PUT body");
        }
        putBodies.push({ key: url, body: init.body });
        return new Response(null, { status: 200 });
      }
      return new Response(null, { status: 404 });
    };

    const uploader = createProtocolArtifactUploader({ protocol }, "steprun_1", "lease-1");
    const uploaded = await uploader.uploadArtifacts([
      { key: "diff", kind: "diff", contentType: "text/x-diff", text: "a\n-b\n+c\n" },
      { key: "prd", kind: "document", contentType: "text/markdown", text: "# Plan" },
    ]);

    // One batch, one /uploads call, sizes declared at mint time (AC2/AC3).
    expect(minted).toEqual([
      { key: "diff", kind: "artifact", sizeBytes: 8 },
      { key: "prd", kind: "artifact", sizeBytes: 6 },
    ]);
    expect(putBodies).toEqual([
      { key: "https://blob.invalid/put/diff", body: "a\n-b\n+c\n" },
      { key: "https://blob.invalid/put/prd", body: "# Plan" },
    ]);
    expect(uploaded).toEqual([
      { key: "diff", kind: "diff", contentType: "text/x-diff", sizeBytes: 8, blobKey: "artifact/steprun_1/diff" },
      { key: "prd", kind: "document", contentType: "text/markdown", sizeBytes: 6, blobKey: "artifact/steprun_1/prd" },
    ]);
  });

  it("a failed PUT drops that artifact from the list — the StepRun is unaffected (AC5)", async () => {
    const { protocol } = fakeProtocol();
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(null, { status: calls === 1 ? 503 : 200 });
    };

    const uploader = createProtocolArtifactUploader({ protocol }, "steprun_1", "lease-1");
    const uploaded = await uploader.uploadArtifacts([
      { key: "lost", kind: "document", contentType: "text/plain", text: "never made it" },
      { key: "kept", kind: "document", contentType: "text/plain", text: "made it" },
    ]);

    expect(uploaded).toEqual([
      { key: "kept", kind: "document", contentType: "text/plain", sizeBytes: 7, blobKey: "artifact/steprun_1/kept" },
    ]);
  });

  it("an empty list mints nothing", async () => {
    const { protocol, minted } = fakeProtocol();
    globalThis.fetch = async () => new Response(null, { status: 200 });

    const uploader = createProtocolArtifactUploader({ protocol }, "steprun_1", "lease-1");
    expect(await uploader.uploadArtifacts([])).toEqual([]);
    expect(minted).toEqual([]);
  });
});
