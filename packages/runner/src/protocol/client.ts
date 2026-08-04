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
  /** The Project's secrets, resolved at claim — handed to the agent call, never written to a file inside the sandbox (AC5). */
  secrets: Record<string, string>;
  /** Default-deny egress allowlist for the sandbox (AC6). */
  egressAllowlist: string[];
  /** The Group an interactive Step's ask: addresses, resolved at claim (null for non-interactive Steps). */
  askGroupId: string | null;
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

export interface UploadGrant {
  key: string;
  uploadUrl: string;
  expiresAt: string;
}

export interface LogChunkWire {
  attempt: number;
  seq: number;
  blobKey: string;
  byteOffset: number;
  size: number;
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
  /** Mints presigned PUT grants for this turn's artifact/session/log objects — the Runner never asks for more than a URL (spec: "Presigned dua arah"). */
  mintUploadGrants(input: {
    stepRunId: string;
    leaseToken: string;
    requests: { key: string; kind: "artifact" | "session" | "log" }[];
  }): Promise<UploadGrant[]>;
  /** Records log-chunk metadata after the bytes are already in the object store — dedup at the primary key, never a 409 (spec: "Log"). */
  recordLogChunks(input: { stepRunId: string; leaseToken: string; chunks: LogChunkWire[] }): Promise<void>;
  /** The commit point of a turn that ends by asking a human (spec: "push branch → unggah session ke blob → POST Question"). */
  submitQuestion(input: {
    stepRunId: string;
    leaseToken: string;
    question: {
      id: string;
      groupId: string;
      kind: "text" | "choice" | "approval" | "edit-artifact";
      body: string;
      options?: { id: string; label: string; description?: string }[];
      multi?: boolean;
      allowOther?: boolean;
      artifactKey?: string;
    };
    ref: { branch: string; sha: string };
    sessionBlobKey?: string;
  }): Promise<{ questionId: string }>;
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

    async mintUploadGrants({ stepRunId, leaseToken, requests }) {
      const { status, body } = await post<{ grants: { key: string; upload_url: string; expires_at: string }[] }>(
        `/step-runs/${stepRunId}/uploads`,
        { lease_token: leaseToken, requests },
      );
      if (status === 409) {
        throw new Error("uploads refused: lease no longer valid");
      }
      if (!(status >= 200 && status < 300)) {
        throw new Error(`uploads failed: HTTP ${status}`);
      }
      return body.grants.map((grant) => ({ key: grant.key, uploadUrl: grant.upload_url, expiresAt: grant.expires_at }));
    },

    async recordLogChunks({ stepRunId, leaseToken, chunks }) {
      const { status } = await post<{ ok: true }>(`/step-runs/${stepRunId}/log-chunks`, {
        lease_token: leaseToken,
        chunks: chunks.map((chunk) => ({
          attempt: chunk.attempt,
          seq: chunk.seq,
          blob_key: chunk.blobKey,
          byte_offset: chunk.byteOffset,
          size: chunk.size,
        })),
      });
      if (status === 409) {
        throw new Error("log-chunks refused: lease no longer valid");
      }
      if (!(status >= 200 && status < 300)) {
        throw new Error(`log-chunks failed: HTTP ${status}`);
      }
    },

    async submitQuestion({ stepRunId, leaseToken, question, ref, sessionBlobKey }) {
      const { status, body } = await post<{ question_id: string }>(`/step-runs/${stepRunId}/question`, {
        lease_token: leaseToken,
        question: {
          id: question.id,
          group_id: question.groupId,
          kind: question.kind,
          body: question.body,
          ...(question.options !== undefined ? { options: question.options } : {}),
          ...(question.multi !== undefined ? { multi: question.multi } : {}),
          ...(question.allowOther !== undefined ? { allow_other: question.allowOther } : {}),
          ...(question.artifactKey !== undefined ? { artifact_key: question.artifactKey } : {}),
        },
        ref,
        ...(sessionBlobKey !== undefined ? { session_blob_key: sessionBlobKey } : {}),
      });
      if (status === 409) {
        throw new Error("question refused: lease no longer valid");
      }
      if (!(status >= 200 && status < 300)) {
        throw new Error(`question failed: HTTP ${status}`);
      }
      return { questionId: body.question_id };
    },
  };
}
