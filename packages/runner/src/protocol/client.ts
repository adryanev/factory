/**
 * The Runner's HTTP client for the Runner <-> control-plane protocol — the
 * real counterpart to `control-plane/test/seam1/fake-runner-client.ts`. The
 * Runner "never asks the world anything" (spec): every field it needs comes
 * in the `/claim` payload, and this client is how it claims, heartbeats, and
 * reports the turn's outcome. Wire shapes are the spec's own `snake_case`.
 */
export interface GitTokenWire {
  token: string;
  expiresAt: string;
  repositoryIds: number[];
  permissions: Record<string, string>;
}

export interface ClaimedStepRun {
  id: string;
  runId: string;
  stepKey: string;
  branchKey: string | null;
  turn: number;
  attempt: number;
  repository: { id: string; owner: string; name: string; defaultBranch: string };
  ref: { branch: string; sha: string };
  definition: unknown;
  definitionFiles: unknown;
  leaseToken: string;
  leaseExpiresAt: string;
  gitTokens: { fetch: GitTokenWire; push: GitTokenWire };
}

export interface HeartbeatReply {
  desiredState: string;
  cancel: string[];
  unknownLeases: string[];
  capsStale: boolean;
  latestRelease: string;
  protocol: { min: number; max: number };
}

export interface ResultReply {
  outcome: "succeeded" | "failed";
  ref: { branch: string; sha: string } | null;
  outputData: unknown;
}

export interface ProtocolClient {
  claim(input: { tags: string[]; slots: number; protocolVersion: number }): Promise<ClaimedStepRun | null>;
  heartbeat(input: { leases: { stepRunId: string; leaseToken: string }[]; capsHash: string | null }): Promise<HeartbeatReply>;
  reportResult(input: {
    stepRunId: string;
    leaseToken: string;
    outcome: "succeeded" | "failed";
    ref?: { branch: string; sha: string };
    outputData?: unknown;
    reason?: string;
  }): Promise<ResultReply>;
}

export function createProtocolClient(baseUrl: string, secret: string): ProtocolClient {
  const post = async <T>(path: string, body: unknown): Promise<{ status: number; body: T }> => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : undefined) as T };
  };

  return {
    async claim({ tags, slots, protocolVersion }) {
      const { status, body } = await post<{ step_run: unknown }>("/claim", {
        tags,
        slots,
        protocol_version: protocolVersion,
      });
      if (status === 426) {
        throw new Error("claim refused: protocol version out of range");
      }
      if (status === 401) {
        throw new Error("claim refused: runner secret invalid or revoked");
      }
      if (!(status >= 200 && status < 300)) {
        throw new Error(`claim failed: HTTP ${status}`);
      }
      const stepRun = body.step_run as ClaimedStepRun | null;
      return stepRun;
    },

    async heartbeat({ leases, capsHash }) {
      const { status, body } = await post<HeartbeatReply>("/heartbeat", {
        leases: leases.map((lease) => ({ step_run_id: lease.stepRunId, lease_token: lease.leaseToken })),
        caps_hash: capsHash,
      });
      if (!(status >= 200 && status < 300)) {
        throw new Error(`heartbeat failed: HTTP ${status}`);
      }
      return body;
    },

    async reportResult({ stepRunId, leaseToken, outcome, ref, outputData, reason }) {
      const { status, body } = await post<ResultReply>(`/step-runs/${stepRunId}/result`, {
        lease_token: leaseToken,
        outcome,
        ...(ref ? { ref } : {}),
        ...(outputData !== undefined ? { output_data: outputData } : {}),
        ...(reason !== undefined ? { reason } : {}),
      });
      if (status === 409) {
        throw new Error("result refused: lease no longer valid");
      }
      if (!(status >= 200 && status < 300)) {
        throw new Error(`result failed: HTTP ${status}`);
      }
      return body;
    },
  };
}
