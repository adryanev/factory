/**
 * The Runner's `AgentSessionStorage` (issue 13, AC2) — the third blob
 * consumer after log chunks and artifacts. The real implementation is pure
 * HTTP over the protocol client's minted grants, so a fake `fetch` proves
 * both directions without a Garage: upload PUTs to the minted URL and records
 * the blob key the control plane minted (never guessed), and download GETs
 * the claimed session's presigned URL.
 */
import { describe, expect, it, vi } from "vitest";
import { createProtocolSessionStorage, type AgentSessionStorage } from "../session-storage.js";
import type { ProtocolClient } from "../protocol/client.js";

function fakeProtocol(): Pick<ProtocolClient, "mintUploadGrants"> & { requests: unknown[] } {
  const requests: unknown[] = [];
  return {
    requests,
    async mintUploadGrants({ requests: batch }) {
      requests.push(batch);
      return batch.map((request) => ({
        key: request.key,
        uploadUrl: `https://blob.invalid/put/${request.key}`,
        expiresAt: "2026-01-01T00:05:00.000Z",
        blobKey: `session/steprun_9/${request.key}`,
      }));
    },
  };
}

function fakeFetch(onRequest: (url: string, init?: RequestInit) => { ok: boolean; text?: string }) {
  return vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const handled = onRequest(String(input), init);
    return {
      ok: handled.ok,
      status: handled.ok ? 200 : 500,
      text: async () => handled.text ?? "",
    } as Response;
  });
}

describe("AgentSessionStorage (issue 13, AC2)", () => {
  it("uploads a captured session JSONL to the minted PUT and returns the control plane's blob key", async () => {
    const protocol = fakeProtocol();
    const fetchImpl = fakeFetch((url, init) => {
      expect(url).toBe("https://blob.invalid/put/sess-7.jsonl");
      expect(init?.method).toBe("PUT");
      expect(init?.body).toBe('{"type":"turn-1"}\n');
      return { ok: true };
    });
    const storage: AgentSessionStorage = createProtocolSessionStorage({ protocol: protocol as never, fetchImpl });

    const blobKey = await storage.uploadSession({
      stepRunId: "steprun_9",
      leaseToken: "lease-1",
      sessionId: "sess-7",
      content: '{"type":"turn-1"}\n',
    });

    expect(blobKey).toBe("session/steprun_9/sess-7.jsonl");
    // One `session` grant, keyed by the session id — the Runner records the
    // blob key it was told, never reconstructs the bucket layout.
    expect(protocol.requests).toEqual([
      [{ key: "sess-7.jsonl", kind: "session" }],
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("downloads a claimed session JSONL by presigned GET", async () => {
    const protocol = fakeProtocol();
    const fetchImpl = fakeFetch((url) => {
      expect(url).toBe("https://blob.invalid/get/sess-7");
      return { ok: true, text: '{"type":"turn-2"}\n' };
    });
    const storage = createProtocolSessionStorage({ protocol: protocol as never, fetchImpl });

    const content = await storage.downloadSession({ getUrl: "https://blob.invalid/get/sess-7" });

    expect(content).toBe('{"type":"turn-2"}\n');
  });

  it("throws when the PUT fails — the executor turns that into a failed turn so no Question is posted without its session", async () => {
    const protocol = fakeProtocol();
    const fetchImpl = fakeFetch(() => ({ ok: false }));
    const storage = createProtocolSessionStorage({ protocol: protocol as never, fetchImpl });

    await expect(
      storage.uploadSession({ stepRunId: "steprun_9", leaseToken: "lease-1", sessionId: "sess-7", content: "x" }),
    ).rejects.toThrow(/HTTP 500/);
  });
});
