/**
 * The Runner's half of the session round-trip — the third blob consumer after
 * log chunks and artifacts (issue 13, AC2: "Session diangkut lewat blob store
 * dengan implementasi `AgentSessionStorage` sendiri"). It is deliberately a
 * small seam like `log-uploader.ts` / `artifact-uploader.ts`: the control
 * plane mints presigned URLs, the Runner PUTs/GETs bytes straight to Garage,
 * and the blob key comes from the grant response, never reconstructed by the
 * Runner.
 *
 * The two directions:
 *
 *  - `uploadSession` runs at the Question commit point (spec: "push branch →
 *    unggah session ke blob → POST Question"). The turn's captured session
 *    JSONL is read from the host file the seam left behind and PUT to a
 *    `session/{stepRunId}/{sessionId}.jsonl` object; the resulting blob key
 *    rides the Question POST. A failed upload must fail the turn — the
 *    invariant is "Question ada ⇒ session pasti ada", so no Question may be
 *    posted without its session (a death-before-POST is retried as an attempt
 *    from the same turn, not a new recovery class).
 *
 *  - `downloadSession` runs on a resumed turn: the `/claim` payload carries a
 *    5-minute presigned GET, and this fetches the JSONL bytes so the turn can
 *    resume the agent from the same conversation on any free machine (AC1).
 */
import type { ProtocolClient } from "./protocol/client.js";

export interface AgentSessionStorage {
  /** Uploads a captured session JSONL; returns the blob key the Question references. */
  uploadSession(input: { stepRunId: string; leaseToken: string; sessionId: string; content: string }): Promise<string>;
  /** Downloads a claimed session JSONL by presigned GET; returns its content. */
  downloadSession(input: { getUrl: string }): Promise<string>;
}

export interface ProtocolSessionStorageDeps {
  protocol: ProtocolClient;
  /** Injectable for tests — the real default is the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** The real, protocol-backed storage. `session/{stepRunId}/{sessionId}.jsonl` is the blob layout — minted by the control plane, recorded by the Runner. */
export function createProtocolSessionStorage(deps: ProtocolSessionStorageDeps): AgentSessionStorage {
  const fetchImpl = deps.fetchImpl ?? fetch;
  return {
    async uploadSession({ stepRunId, leaseToken, sessionId, content }) {
      const grants = await deps.protocol.mintUploadGrants({
        stepRunId,
        leaseToken,
        requests: [{ key: `${sessionId}.jsonl`, kind: "session" }],
      });
      const grant = grants[0];
      if (!grant) {
        throw new Error("session upload refused: no grant was minted");
      }
      const response = await fetchImpl(grant.uploadUrl, {
        method: "PUT",
        headers: { "content-type": "application/jsonl" },
        body: content,
      });
      if (!response.ok) {
        throw new Error(`session upload failed: HTTP ${response.status}`);
      }
      return grant.blobKey;
    },
    async downloadSession({ getUrl }) {
      const response = await fetchImpl(getUrl);
      if (!response.ok) {
        throw new Error(`session download failed: HTTP ${response.status}`);
      }
      return response.text();
    },
  };
}
