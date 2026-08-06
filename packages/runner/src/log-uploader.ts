/**
 * The Runner's log-chunk uploader: the peer-to-peer half of the log path.
 * For each chunk it mints a presigned PUT from the control plane (which owns
 * the Garage credentials), PUTs the bytes **directly to Garage**, then tells
 * the control plane only the metadata (spec: "Runner flush tiap 1 detik atau
 * 256 KiB; control plane hanya mencatat metadata chunk, tidak pernah menerima
 * byte"). The order is the invariant: upload first, record after — a
 * `log_chunks` row existing implies its blob exists (spec: "upload dulu →
 * catat metadata").
 *
 * The blob key is `log/{stepRunId}/{attempt}/{seq}` — the control plane maps
 * `kind: "log"` + the runner-supplied `{attempt}/{seq}` tail into the
 * `log/` prefix (see `domain/step-run-turn.ts`'s `blobKeyFor`), so the two
 * sides agree on where the object lives without the Runner trusting its own
 * layout guess.
 */
import type { LogChunk, LogChunkUploader } from "./log-buffer.js";
import type { ProtocolClient } from "./protocol/client.js";

export interface ProtocolLogChunkUploaderDeps {
  protocol: ProtocolClient;
}

/** Real uploader bound to one StepRun + lease + attempt. */
export function createProtocolLogChunkUploader(
  deps: ProtocolLogChunkUploaderDeps,
  stepRunId: string,
  leaseToken: string,
  attempt: number,
): LogChunkUploader {
  return {
    async upload(this: void, chunk: LogChunk) {
      const key = `${attempt}/${chunk.seq}`;
      const [grant] = await deps.protocol.mintUploadGrants({
        stepRunId,
        leaseToken,
        requests: [{ key, kind: "log" }],
      });
      if (!grant) {
        throw new Error("log chunk upload: no grant minted");
      }
      const putResponse = await fetch(grant.uploadUrl, {
        method: "PUT",
        headers: { "content-type": "text/plain" },
        body: chunk.text,
      });
      if (!putResponse.ok) {
        throw new Error(`log chunk PUT to object store failed: HTTP ${putResponse.status}`);
      }
      await deps.protocol.recordLogChunks({
        stepRunId,
        leaseToken,
        chunks: [
          {
            attempt,
            seq: chunk.seq,
            blobKey: `log/${stepRunId}/${key}`,
            byteOffset: chunk.byteOffset,
            size: chunk.size,
          },
        ],
      });
    },
  };
}
