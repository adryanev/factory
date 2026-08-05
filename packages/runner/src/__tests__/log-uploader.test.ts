/**
 * The Runner's log-chunk uploader (issue #7): the order that makes the log
 * path honest — PUT the bytes to the object store first, record metadata
 * after (spec: "upload dulu → catat metadata", invariant "baris log_chunks
 * ada ⇒ blob pasti ada"). The control plane is a URL-minting metadata sink;
 * the bytes never touch it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createProtocolLogChunkUploader } from "../log-uploader.js";
import type { LogChunk } from "../log-buffer.js";
import type { ProtocolClient, LogChunkWire, UploadGrant } from "../protocol/client.js";

function fakeProtocol(records: { key: string; kind: string }[] = []): {
  protocol: ProtocolClient;
  minted: { key: string; kind: string }[];
  recorded: LogChunkWire[];
} {
  const minted = records;
  const recorded: LogChunkWire[] = [];
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
          blobKey: `log/steprun_1/${request.key}`,
        }));
        return grants;
      },
      async recordLogChunks({ chunks }) {
        recorded.push(...chunks);
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
    recorded,
  };
}

describe("createProtocolLogChunkUploader", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("mints a log PUT for {attempt}/{seq}, PUTs the bytes to Garage, then records metadata with the log/ blob key", async () => {
    const { protocol, minted, recorded } = fakeProtocol();
    const putBodies: string[] = [];
    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PUT") {
        putBodies.push(String(init.body));
        return new Response(null, { status: 200 });
      }
      return new Response(null, { status: 404 });
    };

    const uploader = createProtocolLogChunkUploader({ protocol }, "steprun_1", "lease-1", 1);
    const chunk: LogChunk = { seq: 0, byteOffset: 0, size: 12, text: "hello world\n" };
    await uploader.upload(chunk);

    expect(minted).toEqual([{ key: "1/0", kind: "log" }]);
    expect(putBodies).toEqual(["hello world\n"]);
    expect(recorded).toEqual([
      {
        attempt: 1,
        seq: 0,
        blobKey: "log/steprun_1/1/0",
        byteOffset: 0,
        size: 12,
      },
    ]);
  });

  it("never records metadata when the PUT fails — upload first, record after", async () => {
    const { protocol, recorded } = fakeProtocol();
    globalThis.fetch = async () => new Response(null, { status: 503 });

    const uploader = createProtocolLogChunkUploader({ protocol }, "steprun_1", "lease-1", 1);
    await expect(uploader.upload({ seq: 0, byteOffset: 0, size: 5, text: "data" })).rejects.toThrow(/503/);
    expect(recorded).toHaveLength(0);
  });
});
