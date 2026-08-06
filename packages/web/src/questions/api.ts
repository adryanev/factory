/**
 * The web <-> control-plane client for the human-in-the-loop surface (issue
 * 13). `camelCase` bodies, session-cookie auth (same origin, so `credentials`
 * is unnecessary — the browser sends the cookie automatically), and the CSRF
 * header every mutating request needs (spec: "CSRF ditutup SameSite=Lax +
 * kewajiban header non-sederhana").
 */
import type { Answer } from "@factory/shared";

export const CSRF_HEADER_NAME = "x-factory-csrf";
export const CSRF_HEADER_VALUE = "1";

/** The control plane's `QuestionState` (web surface). */
export interface QuestionState {
  id: string;
  stepRunId: string;
  groupId: string;
  kind: "text" | "choice" | "approval" | "edit-artifact";
  body: string;
  options?: { id: string; label: string; description?: string }[];
  multi?: boolean;
  allowOther?: boolean;
  artifactKey: string | null;
  createdAt: string;
  answeredAt: string | null;
  answeredByPrincipalId: string | null;
  answer: unknown | null;
  stepRunOutcome: string;
  stepKey: string;
  branchKey: string | null;
  turn: number;
  runId: string;
  projectId: string;
  projectName: string;
}

export interface StepRunState {
  id: string;
  runId: string;
  stepKey: string;
  branchKey: string | null;
  turn: number;
  attempt: number;
  outcome: string;
  outputData: unknown;
  finalPrompt: string | null;
}

export interface RunState {
  id: string;
  projectId: string;
  pipelinePath: string;
  parentRunId: string | null;
  cancelRequestedAt: string | null;
  outcome: string | null;
  stepRuns: StepRunState[];
}

export interface GrillingSummary {
  draftRevisions: number;
  humanEdits: number;
  decisions: number;
  openQuestions: number;
}

export interface ArtifactHistory {
  id: string;
  key: string;
  kind: string;
  contentType: string;
  sizeBytes: number;
  authoredByPrincipalId: string | null;
  createdAt: string;
  stepRunId: string;
  turn: number;
}

export async function fetchArtifactContent(artifactId: string): Promise<string> {
  const { body } = await fetchJson<{ getUrl: string }>(`/artifacts/${artifactId}`);
  const response = await fetch(body.getUrl);
  if (!response.ok) throw new Error(`artifact read failed: HTTP ${response.status}`);
  return response.text();
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const response = await fetch(url, init);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : undefined) as T };
}

/** The "Menunggu saya" list — every open Question whose audience Group contains the caller. */
export async function fetchWaitingQuestions(): Promise<QuestionState[]> {
  const { body } = await fetchJson<{ questions: QuestionState[] }>("/questions/waiting");
  return body.questions;
}

/** The result of an answering write: accepted, or the race-lost state carrying the latest Question and the caller's own typed answer. */
export type AnswerResult =
  | { status: "accepted" }
  | {
      status: "race-lost";
      question: QuestionState;
      typedAnswer: Answer;
    };

/** Records an answer. A 409 is the ordinary outcome of losing the race — it returns the latest state instead of throwing. */
export async function submitAnswer(questionId: string, answer: Answer): Promise<AnswerResult> {
  if (answer.kind === "edit-artifact") {
    await uploadArtifactEdit(questionId, answer.content);
  }
  const { status, body } = await fetchJson<{ question: QuestionState; typedAnswer: Answer }>(
    `/questions/${questionId}/answer`,
    {
      method: "POST",
      headers: { "content-type": "application/json", [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
      body: JSON.stringify({ answer }),
    },
  );
  if (status === 200) {
    return { status: "accepted" };
  }
  if (status === 409) {
    return { status: "race-lost", question: body.question, typedAnswer: body.typedAnswer };
  }
  throw new Error(`answer failed: HTTP ${status}`);
}

/** Uploads draft bytes directly to the object store before the Question CAS. */
export async function uploadArtifactEdit(questionId: string, content: string): Promise<void> {
  const sizeBytes = new TextEncoder().encode(content).byteLength;
  const { status, body } = await fetchJson<{
    key: string;
    contentType: string;
    uploadUrl: string;
    blobKey: string;
    expiresAt: string;
  }>(`/questions/${questionId}/artifact-upload`, {
    method: "POST",
    headers: { "content-type": "application/json", [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
    body: JSON.stringify({ sizeBytes }),
  });
  if (status !== 200) {
    throw new Error(`draft upload grant failed: HTTP ${status}`);
  }
  const response = await fetch(body.uploadUrl, {
    method: "PUT",
    headers: { "content-type": body.contentType },
    body: content,
  });
  if (!response.ok) {
    throw new Error(`draft upload failed: HTTP ${response.status}`);
  }
}

export async function fetchRun(projectId: string, runId: string): Promise<RunState> {
  const { body } = await fetchJson<{ run: RunState; stepRuns: StepRunState[] }>(
    `/projects/${projectId}/runs/${runId}`,
  );
  return { ...body.run, stepRuns: body.stepRuns };
}

export async function fetchGrillingSummary(projectId: string, runId: string): Promise<GrillingSummary> {
  const { body } = await fetchJson<GrillingSummary>(`/projects/${projectId}/runs/${runId}/summary`);
  return body;
}

export async function fetchRunArtifacts(projectId: string, runId: string, key = "prd"): Promise<ArtifactHistory[]> {
  const { body } = await fetchJson<{ artifacts: ArtifactHistory[] }>(
    `/projects/${projectId}/runs/${runId}/artifacts?key=${encodeURIComponent(key)}`,
  );
  return body.artifacts;
}

export async function cancelRun(projectId: string, runId: string): Promise<void> {
  const { status } = await fetchJson<unknown>(`/projects/${projectId}/runs/${runId}/cancel`, {
    method: "POST",
    headers: { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
  });
  if (status !== 200) throw new Error(`cancel failed: HTTP ${status}`);
}

export async function rewindRun(
  projectId: string,
  parentRunId: string,
  stepRunId: string,
  id: string,
): Promise<RunState> {
  const { status, body } = await fetchJson<{ run: RunState; stepRuns: StepRunState[] }>(
    `/projects/${projectId}/runs/${parentRunId}/rewind`,
    {
      method: "POST",
      headers: { "content-type": "application/json", [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
      body: JSON.stringify({ id, stepRunId }),
    },
  );
  if (status !== 201) throw new Error(`rewind failed: HTTP ${status}`);
  return { ...body.run, stepRuns: body.stepRuns };
}
