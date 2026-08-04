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

async function fetchJson<T>(url: string, init?: RequestInit): Promise<{ status: number; body: T }> {
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
