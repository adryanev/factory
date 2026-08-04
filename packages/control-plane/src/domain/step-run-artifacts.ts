/**
 * The browser's artifact read surface (AC9): list a StepRun's artifacts and
 * fetch one, minting a presigned GET *after* the authorization check
 * (spec: "Presigned GET di-mint control plane setelah cek izin"). The
 * control plane never reads a byte — it reads metadata and hands the browser
 * a URL to Garage (spec: "Byte tidak pernah lewat control plane").
 *
 * Read authorization is exactly Project membership — `requireProjectMembership`,
 * the same gate `step-run-logs.ts`'s `readLogChunks` uses. The org `owner`
 * is NOT automatically a member (spec: "`owner` org tidak otomatis dapat
 * akses data Project; ia harus menambahkan dirinya jadi anggota").
 */
import { and, desc, eq } from "drizzle-orm";
import type { ArtifactKind, Id } from "@factory/shared";
import { artifacts, runs, stepRuns } from "../db/schema.js";
import type { AppDeps } from "../deps.js";
import { NotFoundError } from "./errors.js";
import { requireProjectMembership } from "./projects.js";
import type { Principal } from "./principal.js";

export interface ArtifactMeta {
  id: Id<"artifact">;
  key: string;
  kind: ArtifactKind;
  contentType: string;
  sizeBytes: number;
  createdAt: Date;
}

export interface ArtifactRead extends ArtifactMeta {
  /** Freshly-minted 5-minute presigned GET — the browser fetches the bytes straight from Garage. */
  getUrl: string;
  /** The instant the presigned GET stops being valid (spec: "Presigned 5 menit dinyatakan"). */
  expiresAt: Date;
}

function toMeta(row: typeof artifacts.$inferSelect): ArtifactMeta {
  return {
    id: row.id,
    key: row.key,
    kind: row.kind,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt,
  };
}

async function loadStepRunProject(
  deps: Pick<AppDeps, "db">,
  stepRunId: Id<"steprun">,
): Promise<Id<"project">> {
  const [row] = await deps.db
    .select({ projectId: runs.projectId })
    .from(stepRuns)
    .innerJoin(runs, eq(runs.id, stepRuns.runId))
    .where(eq(stepRuns.id, stepRunId));
  if (!row) {
    throw new NotFoundError("step run", stepRunId);
  }
  return row.projectId;
}

/**
 * Lists one StepRun's artifacts, newest-recorded first (the artifact id is
 * time-ordered — spec: "Id: UUIDv7 ... terurut waktu"). The optional `key`
 * filter is what makes the spec's "riwayat adalah kueri per key diurutkan
 * menurut turn" expressible from the UI: list each turn's StepRun with
 * `?key=prd` and the turns already sort the history.
 */
export async function listStepRunArtifacts(
  deps: Pick<AppDeps, "db">,
  principal: Principal,
  stepRunId: Id<"steprun">,
  key?: string,
): Promise<ArtifactMeta[]> {
  const projectId = await loadStepRunProject(deps, stepRunId);
  await requireProjectMembership(deps, principal, projectId);

  const rows = await deps.db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.stepRunId, stepRunId), key === undefined ? undefined : eq(artifacts.key, key)))
    .orderBy(desc(artifacts.createdAt));
  return rows.map(toMeta);
}

/**
 * Fetches one artifact by id — metadata plus a freshly-minted presigned GET.
 * Membership is checked before the URL is minted (spec), so a non-member can
 * neither read the metadata nor reach the blob.
 */
export async function getArtifact(
  deps: Pick<AppDeps, "db" | "objectStore">,
  principal: Principal,
  artifactId: Id<"artifact">,
): Promise<ArtifactRead> {
  const [artifact] = await deps.db.select().from(artifacts).where(eq(artifacts.id, artifactId));
  if (!artifact) {
    throw new NotFoundError("artifact", artifactId);
  }
  const projectId = await loadStepRunProject(deps, artifact.stepRunId);
  await requireProjectMembership(deps, principal, projectId);

  const { url, expiresAt } = await deps.objectStore.mintGetUrl(artifact.blobKey);
  return { ...toMeta(artifact), getUrl: url, expiresAt };
}
