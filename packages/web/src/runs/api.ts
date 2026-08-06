import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from "../questions/api";
import type { StepRunStatus } from "../tokens/status";

export interface RunRecord {
  id: string;
  projectId: string;
  pipelineRepositoryId: string;
  pipelinePath: string;
  triggerKind: "automation" | "manual";
  triggeredByPrincipalId: string;
  credentialPrincipalId: string;
  refBranch: string;
  refSha: string;
  parentRunId: string | null;
  cancelRequestedAt: string | null;
  outcome: "succeeded" | "failed" | "cancelled" | null;
  endedAt: string | null;
  definition?: string;
  definitionFiles?: Record<string, string>;
}

export interface StepRunRecord {
  id: string;
  runId: string;
  repositoryId: string;
  stepKey: string;
  branchKey: string | null;
  turn: number;
  attempt: number;
  outcome: StepRunStatus;
  reason: string | null;
  kind: "pull-request" | null;
  requiredTags: string[];
  readyAt: string;
  startedAt: string | null;
  outputRefBranch: string | null;
  outputRefSha: string | null;
  outputData: unknown | null;
  prNumber: number | null;
  prUrl: string | null;
  finalPrompt: string | null;
}

export interface RunDetail {
  run: RunRecord;
  stepRuns: StepRunRecord[];
}

export interface RunCostRecord {
  totalCostUsd: string | null;
  supportedAttempts: number;
  unsupportedAttempts: number;
  credentialPrincipalId: string;
  runEnded: boolean;
}

export interface LogChunkRecord {
  seq: number;
  byteOffset: number;
  size: number;
  getUrl: string;
  expiresAt: string;
}

export interface LogTailRecord {
  chunks: LogChunkRecord[];
  nextOffset: number;
  attempt: number;
  ended: boolean;
}

export interface ArtifactRecord {
  id: string;
  key: string;
  kind: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
}

export type RunPollResult =
  | { status: "ok"; data: RunDetail; etag: string | null }
  | { status: "not-modified"; etag: string | null };

async function responseBody<T>(response: Response): Promise<T | undefined> {
  const text = await response.text();
  return text ? (JSON.parse(text) as T) : undefined;
}

function requestError(response: Response): Error {
  return new Error(`request failed: HTTP ${response.status}`);
}

/**
 * Reads the Graph endpoint. A 304 is intentionally handled before reading
 * the response body: browsers and test doubles both expose it as body-less.
 */
export async function fetchRun(
  projectId: string,
  runId: string,
  etag?: string,
): Promise<RunPollResult> {
  const headers: Record<string, string> = {};
  if (etag !== undefined) {
    headers["if-none-match"] = etag;
  }
  const response = await fetch(
    `/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}`,
    { headers },
  );
  const nextEtag = response.headers.get("etag") ?? etag ?? null;
  if (response.status === 304) {
    return { status: "not-modified", etag: nextEtag };
  }
  if (!response.ok) {
    throw requestError(response);
  }
  const body = await responseBody<RunDetail>(response);
  if (body === undefined) {
    throw new Error("run response was empty");
  }
  return { status: "ok", data: body, etag: nextEtag };
}

/** Records cancel intent; the returned Run is not a promise that workers have stopped. */
export async function cancelRun(projectId: string, runId: string): Promise<RunRecord> {
  const response = await fetch(
    `/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/cancel`,
    {
      method: "POST",
      headers: { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
    },
  );
  if (!response.ok) {
    throw requestError(response);
  }
  const body = await responseBody<{ run: RunRecord }>(response);
  if (body?.run === undefined) {
    throw new Error("cancel response was empty");
  }
  return body.run;
}

export async function fetchRunCost(projectId: string, runId: string): Promise<RunCostRecord> {
  const response = await fetch(
    `/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/cost`,
  );
  if (!response.ok) {
    throw requestError(response);
  }
  const body = await responseBody<RunCostRecord>(response);
  if (body === undefined) {
    throw new Error("run cost response was empty");
  }
  return body;
}

export async function fetchLogTail(
  stepRunId: string,
  attempt: number,
  offset: number,
): Promise<LogTailRecord> {
  const query = new URLSearchParams({ attempt: String(attempt), offset: String(offset) });
  const response = await fetch(`/step-runs/${encodeURIComponent(stepRunId)}/log?${query}`);
  if (!response.ok) {
    throw requestError(response);
  }
  const body = await responseBody<LogTailRecord>(response);
  if (body === undefined) {
    throw new Error("log response was empty");
  }
  return body;
}

/** Log bytes travel directly from the presigned Garage URL, never through the control plane. */
export async function fetchLogChunk(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw requestError(response);
  }
  return response.text();
}

export async function fetchStepRunArtifacts(stepRunId: string): Promise<ArtifactRecord[]> {
  const response = await fetch(`/step-runs/${encodeURIComponent(stepRunId)}/artifacts`);
  if (!response.ok) {
    throw requestError(response);
  }
  const body = await responseBody<{ artifacts: ArtifactRecord[] }>(response);
  return body?.artifacts ?? [];
}
