/**
 * The Runner's artifact uploader: the peer-to-peer half of the artifact path.
 * All of a turn's artifacts are minted as ONE `/uploads` batch (spec: "satu
 * batch berisi seluruh artefak plus session", AC2), each is PUT straight to
 * Garage, and only the successfully-uploaded subset is handed back to ride
 * `POST /result` (spec: "upload dulu → catat metadata"; AC4/AC5 — an artifact
 * that fails to upload permanently is simply not listed, and the StepRun is
 * unaffected).
 *
 * The blob key comes from the grant response (`blob_key`), never reconstructed
 * by the Runner — the control plane mints the key and the Runner records what
 * it was told (see `domain/step-run-turn.ts`).
 */
import type { ArtifactKind } from "@factory/shared";
import type { ProtocolClient } from "./protocol/client.js";

export interface ArtifactToUpload {
  key: string;
  kind: ArtifactKind;
  contentType: string;
  /** The bytes — the artifact body as text today (the diff is always text; the closed `kind` set's renderers are all text-oriented). */
  text: string;
}

export interface UploadedArtifact {
  key: string;
  kind: ArtifactKind;
  contentType: string;
  sizeBytes: number;
  blobKey: string;
}

export interface ArtifactUploader {
  /**
   * Uploads the batch. Returns exactly the artifacts whose PUT succeeded —
   * a failed upload is absent, and never fails the turn (AC5). Deterministic
   * order: the result array mirrors the input order.
   */
  uploadArtifacts(artifacts: ArtifactToUpload[]): Promise<UploadedArtifact[]>;
}

export interface ProtocolArtifactUploaderDeps {
  protocol: ProtocolClient;
}

/** Real uploader bound to one StepRun + lease. */
export function createProtocolArtifactUploader(
  deps: ProtocolArtifactUploaderDeps,
  stepRunId: string,
  leaseToken: string,
): ArtifactUploader {
  return {
    async uploadArtifacts(artifacts) {
      if (artifacts.length === 0) {
        return [];
      }
      const grants = await deps.protocol.mintUploadGrants({
        stepRunId,
        leaseToken,
        requests: artifacts.map((artifact) => ({
          key: artifact.key,
          kind: "artifact",
          sizeBytes: Buffer.byteLength(artifact.text, "utf-8"),
        })),
      });
      const uploaded: UploadedArtifact[] = [];
      for (let index = 0; index < artifacts.length; index++) {
        const grant = grants[index];
        if (!grant) {
          continue;
        }
        let putResponse: Response;
        try {
          putResponse = await fetch(grant.uploadUrl, {
            method: "PUT",
            headers: { "content-type": artifacts[index]!.contentType },
            body: artifacts[index]!.text,
          });
        } catch {
          continue; // a network fault is the same as a failed PUT — not listed (AC5).
        }
        if (!putResponse.ok) {
          continue; // AC5: a permanently-failed upload is simply not listed.
        }
        uploaded.push({
          key: artifacts[index]!.key,
          kind: artifacts[index]!.kind,
          contentType: artifacts[index]!.contentType,
          sizeBytes: Buffer.byteLength(artifacts[index]!.text, "utf-8"),
          blobKey: grant.blobKey,
        });
      }
      return uploaded;
    },
  };
}
