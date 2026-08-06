import { afterEach, describe, expect, it, vi } from "vitest";
import { createProtocolClient } from "./client.js";

interface RecordedRequest {
  url: string;
  body: unknown;
  authorization: string | null;
}

function stubFetch(responder: (request: RecordedRequest) => { status?: number; body?: unknown }) {
  const requests: RecordedRequest[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const request: RecordedRequest = {
      url,
      body: JSON.parse(init.body as string),
      authorization: headers["authorization"] ?? null,
    };
    requests.push(request);
    const { status = 200, body = {} } = responder(request);
    return new Response(JSON.stringify(body), { status });
  });
  return requests;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("heartbeat", () => {
  it("maps every snake_case field of the reply, not just the ones whose names happen to match", async () => {
    stubFetch(() => ({
      body: {
        desired_state: "draining",
        cancel: ["sr_1"],
        unknown_leases: ["sr_2"],
        caps_stale: true,
        latest_release: "0.4.0",
        protocol: { min: 1, max: 2 },
      },
    }));
    const client = createProtocolClient("https://factory.example", "rnr_secret");

    const reply = await client.heartbeat({ leases: [{ stepRunId: "sr_1", leaseToken: "lt_1" }], capsHash: "abc" });

    expect(reply).toEqual({
      desiredState: "draining",
      cancel: ["sr_1"],
      unknownLeases: ["sr_2"],
      capsStale: true,
      latestRelease: "0.4.0",
      protocol: { min: 1, max: 2 },
    });
  });

  it("sends the leases in the wire's snake_case shape", async () => {
    const requests = stubFetch(() => ({
      body: { desired_state: "active", cancel: [], unknown_leases: [], caps_stale: false, latest_release: "0.1.0", protocol: { min: 1, max: 1 } },
    }));
    const client = createProtocolClient("https://factory.example", "rnr_secret");

    await client.heartbeat({ leases: [{ stepRunId: "sr_9", leaseToken: "lt_9" }], capsHash: null });

    expect(requests[0]?.url).toBe("https://factory.example/heartbeat");
    expect(requests[0]?.body).toEqual({ leases: [{ step_run_id: "sr_9", lease_token: "lt_9" }], caps_hash: null });
    expect(requests[0]?.authorization).toBe("Bearer rnr_secret");
  });
});

describe("reportCapabilities", () => {
  it("posts the hash and the full report, omitting release_version when absent", async () => {
    const requests = stubFetch(() => ({ body: { ok: true } }));
    const client = createProtocolClient("https://factory.example", "rnr_secret");

    await client.reportCapabilities({ capsHash: "hash_1", capabilities: { execMode: "docker" } });

    expect(requests[0]?.url).toBe("https://factory.example/runners/me/capabilities");
    expect(requests[0]?.body).toEqual({ caps_hash: "hash_1", capabilities: { execMode: "docker" } });
  });

  it("throws on a rejected report rather than pretending the control plane recorded it", async () => {
    stubFetch(() => ({ status: 401 }));
    const client = createProtocolClient("https://factory.example", "rnr_secret");

    await expect(
      client.reportCapabilities({ capsHash: "hash_1", capabilities: {} }),
    ).rejects.toThrow(/HTTP 401/);
  });
});

describe("drain", () => {
  it("posts an empty body to the self-drain path", async () => {
    const requests = stubFetch(() => ({ body: { ok: true } }));
    const client = createProtocolClient("https://factory.example", "rnr_secret");

    await client.drain();

    expect(requests[0]?.url).toBe("https://factory.example/runners/me/drain");
    expect(requests[0]?.body).toEqual({});
  });
});
