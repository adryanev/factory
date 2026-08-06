/**
 * The Runner's HTTP client for the Runner <-> control-plane protocol — the
 * real counterpart to `control-plane/test/seam1/fake-runner-client.ts`. The
 * Runner "never asks the world anything" (spec): every field it needs comes
 * in the `/claim` payload, and this client is how it claims, heartbeats, and
 * reports the turn's outcome. Wire shapes are the spec's own `snake_case`.
 */
import type { JoinManifestEntry } from "@factory/shared";

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
  /**
   * The previous turn's session, when this is a resumed turn (issue 13, AC2):
   * the blob the Runner downloads and hands to the agent's `resumeSession`.
   * Null for a fresh turn.
   */
  session: { id: string; blobKey: string; getUrl: string; expiresAt: string } | null;
  /**
   * The Join manifest (issue #11, AC7): the upstream branches this Join Step
   * gathers, as data. Empty for a Step that joins nothing. The Runner fetches
   * only the entries whose `repo` equals its own repository; the rest are
   * reads, never checkouts (ticket 21).
   */
  joinManifest: JoinManifestEntry[];
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
  /** The exact object the PUT writes — the Runner records it, never guesses the bucket layout. */
  blobKey: string;
}

export interface LogChunkWire {
  attempt: number;
  seq: number;
  blobKey: string;
  byteOffset: number;
  size: number;
}

export interface ArtifactWire {
  key: string;
  kind: "diff" | "transcript" | "document" | "structured" | "command-output" | "binary";
  contentType: string;
  sizeBytes: number;
}

export interface ProtocolClient {
  claim(input: { tags: string[]; slots: number; protocolVersion: number }): Promise<ClaimedStepRun | null>;
  heartbeat(input: { leases: { stepRunId: string; leaseToken: string }[]; capsHash: string | null }): Promise<HeartbeatReply>;
  /** Full capabilities report, sent when a heartbeat reply reports the control plane's copy is stale (`capsStale`). */
  reportCapabilities(input: { capsHash: string; capabilities: unknown; releaseVersion?: string }): Promise<void>;
  /** The Runner asking to stop taking new work while it finishes what it holds — the SIGTERM path. */
  drain(): Promise<void>;
  reportResult(input: {
    stepRunId: string;
    leaseToken: string;
    outcome: "succeeded" | "failed";
    ref?: { branch: string; sha: string };
    outputData?: unknown;
    reason?: string;
    /** Metadata of the artifacts that already uploaded, riding this final request (spec: "Metadata Artifact menumpang request akhir itu"). */
    artifacts?: ArtifactWire[];
  }): Promise<ResultReply>;
  /** Mints presigned PUT grants for this turn's artifact/session/log objects — the Runner never asks for more than a URL (spec: "Presigned dua arah"). Artifacts declare `sizeBytes` so the quota is checked at URL-mint time, before a byte is uploaded. */
  mintUploadGrants(input: {
    stepRunId: string;
    leaseToken: string;
    requests: { key: string; kind: "artifact" | "session" | "log"; sizeBytes?: number }[];
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
    /** The agent session id the blob carries — preserved so a resumed turn can `resumeSession` it (issue 13, AC2). */
    sessionId?: string;
  }): Promise<{ questionId: string }>;
}

/**
 * Any non-2xx from the control plane, carrying the status so the caller can
 * consult `decideOnStatus` (the spec's error table) instead of parsing a
 * message string. The one status that stops a Runner is 401; everything else
 * is a backoff-and-retry, and that decision belongs to the caller.
 */
export class ProtocolError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
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
        throw new ProtocolError(status, "claim refused: protocol version out of range");
      }
      if (status === 401) {
        throw new ProtocolError(status, "claim refused: runner secret invalid or revoked");
      }
      if (!(status >= 200 && status < 300)) {
        throw new ProtocolError(status, `claim failed: HTTP ${status}`);
      }
      const wire = body.step_run as (Omit<ClaimedStepRun, "session"> & {
        session?: { id: string; blob_key: string; get_url: string; expires_at: string } | null;
      }) | null;
      const stepRun = wire as ClaimedStepRun | null;
      if (stepRun) {
        stepRun.joinManifest = stepRun.joinManifest ?? [];
        stepRun.session =
          wire?.session === null || wire?.session === undefined
            ? null
            : {
                id: wire.session.id,
                blobKey: wire.session.blob_key,
                getUrl: wire.session.get_url,
                expiresAt: wire.session.expires_at,
              };
      }
      return stepRun;
    },

    async heartbeat({ leases, capsHash }) {
      const { status, body } = await post<{
        desired_state: string;
        cancel: string[];
        unknown_leases: string[];
        caps_stale: boolean;
        latest_release: string;
        protocol: { min: number; max: number };
      }>("/heartbeat", {
        leases: leases.map((lease) => ({ step_run_id: lease.stepRunId, lease_token: lease.leaseToken })),
        caps_hash: capsHash,
      });
      if (!(status >= 200 && status < 300)) {
        throw new ProtocolError(status, `heartbeat failed: HTTP ${status}`);
      }
      return {
        desiredState: body.desired_state,
        cancel: body.cancel,
        unknownLeases: body.unknown_leases,
        capsStale: body.caps_stale,
        latestRelease: body.latest_release,
        protocol: body.protocol,
      };
    },

    async reportCapabilities({ capsHash, capabilities, releaseVersion }) {
      const { status } = await post<{ ok: true }>("/runners/me/capabilities", {
        caps_hash: capsHash,
        capabilities,
        ...(releaseVersion === undefined ? {} : { release_version: releaseVersion }),
      });
      if (!(status >= 200 && status < 300)) {
        throw new ProtocolError(status, `capabilities report failed: HTTP ${status}`);
      }
    },

    async drain() {
      const { status } = await post<{ ok: true }>("/runners/me/drain", {});
      if (!(status >= 200 && status < 300)) {
        throw new ProtocolError(status, `drain failed: HTTP ${status}`);
      }
    },

    async reportResult({ stepRunId, leaseToken, outcome, ref, outputData, reason, artifacts }) {
      const { status, body } = await post<ResultReply>(`/step-runs/${stepRunId}/result`, {
        lease_token: leaseToken,
        outcome,
        ...(ref ? { ref } : {}),
        ...(outputData !== undefined ? { output_data: outputData } : {}),
        ...(reason !== undefined ? { reason } : {}),
        ...(artifacts !== undefined && artifacts.length > 0
          ? {
              artifacts: artifacts.map((artifact) => ({
                key: artifact.key,
                kind: artifact.kind,
                content_type: artifact.contentType,
                size_bytes: artifact.sizeBytes,
              })),
            }
          : {}),
      });
      if (status === 409) {
        throw new ProtocolError(status, "result refused: lease no longer valid");
      }
      if (!(status >= 200 && status < 300)) {
        throw new ProtocolError(status, `result failed: HTTP ${status}`);
      }
      return body;
    },

    async mintUploadGrants({ stepRunId, leaseToken, requests }) {
      const { status, body } = await post<{
        grants: { key: string; blob_key: string; upload_url: string; expires_at: string }[];
      }>(`/step-runs/${stepRunId}/uploads`, { lease_token: leaseToken, requests });
      if (status === 409) {
        throw new ProtocolError(status, "uploads refused: lease no longer valid");
      }
      if (!(status >= 200 && status < 300)) {
        throw new ProtocolError(status, `uploads failed: HTTP ${status}`);
      }
      return body.grants.map((grant) => ({
        key: grant.key,
        uploadUrl: grant.upload_url,
        expiresAt: grant.expires_at,
        blobKey: grant.blob_key,
      }));
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
        throw new ProtocolError(status, "log-chunks refused: lease no longer valid");
      }
      if (!(status >= 200 && status < 300)) {
        throw new ProtocolError(status, `log-chunks failed: HTTP ${status}`);
      }
    },

    async submitQuestion({ stepRunId, leaseToken, question, ref, sessionBlobKey, sessionId }) {
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
        ...(sessionId !== undefined ? { session_id: sessionId } : {}),
      });
      if (status === 409) {
        throw new ProtocolError(status, "question refused: lease no longer valid");
      }
      if (!(status >= 200 && status < 300)) {
        throw new ProtocolError(status, `question failed: HTTP ${status}`);
      }
      return { questionId: body.question_id };
    },
  };
}
