/**
 * The answering surface (issue 13): one form per Question kind. The draft is
 * local component state, so losing the answering race never discards what the
 * human typed — the 409's latest state is shown alongside their still-present
 * draft (AC8: "ketikan yang telanjur ditulis tidak dibuang").
 */
import { useState } from "react";
import type { Answer } from "@factory/shared";
import type { AnswerResult, QuestionState } from "./api";

export interface AnswerFormProps {
  question: QuestionState;
  onSubmit: (answer: Answer) => Promise<AnswerResult>;
  onAnswered: () => void;
}

/** Why the race was lost, for the human — the latest state is the source of truth, this is only the one-line gloss (AC8). */
function raceReason(question: QuestionState): string {
  if (question.answeredByPrincipalId !== null) {
    return `answered by ${question.answeredByPrincipalId}`;
  }
  if (question.answeredAt !== null) {
    return "already answered";
  }
  return "no longer open (its StepRun moved on)";
}

export function AnswerForm({ question, onSubmit, onAnswered }: AnswerFormProps): React.JSX.Element {
  const [draft, setDraft] = useState<Answer | null>(null);
  const [latest, setLatest] = useState<QuestionState | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // The typed answer that will be sent. Always non-null: every kind has a
  // sensible default draft, so the per-kind forms below never see `undefined`.
  const currentDraft: Answer =
    draft ??
    (question.kind === "text"
      ? { kind: "text", value: "" }
      : question.kind === "approval"
        ? { kind: "approval", approved: true }
        : question.kind === "choice"
          ? { kind: "choice", ids: [] }
          : { kind: "edit-artifact", content: "" });

  const submit = async (answer: Answer): Promise<void> => {
    setSubmitting(true);
    try {
      const result = await onSubmit(answer);
      if (result.status === "accepted") {
        onAnswered();
        return;
      }
      // Race lost — state, not error: show the latest Question and keep the
      // draft intact (AC8).
      setLatest(result.question);
    } finally {
      setSubmitting(false);
    }
  };

  const kind = question.kind;
  return (
    <div data-testid={`answer-form-${question.id}`} data-kind={kind}>
      {latest !== null ? (
        <p role="status" data-testid="race-lost">
          This question was {raceReason(latest)}. The latest state is shown below; your draft is
          still in the field.
        </p>
      ) : null}

      {kind === "approval" ? (
        <ApprovalForm
          question={question}
          draft={currentDraft}
          onChange={setDraft}
          submitting={submitting}
          onSubmit={submit}
        />
      ) : null}
      {kind === "text" ? (
        <TextForm question={question} draft={currentDraft} onChange={setDraft} submitting={submitting} onSubmit={submit} />
      ) : null}
      {kind === "choice" ? (
        <ChoiceForm question={question} draft={currentDraft} onChange={setDraft} submitting={submitting} onSubmit={submit} />
      ) : null}
      {kind === "edit-artifact" ? (
        <p data-testid="edit-artifact">Artifact editing is not available here yet.</p>
      ) : null}
    </div>
  );
}

interface DraftFormProps {
  question: QuestionState;
  draft: Answer;
  onChange: (answer: Answer) => void;
  submitting: boolean;
  onSubmit: (answer: Answer) => Promise<void>;
}

function ApprovalForm({ question, draft, onChange, submitting, onSubmit }: DraftFormProps): React.JSX.Element {
  const current = draft as Extract<Answer, { kind: "approval" }>;
  const [reason, setReason] = useState(current.reason ?? "");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit({ kind: "approval", approved: current.approved, ...(reason ? { reason } : {}) });
      }}
    >
      <p>{question.body}</p>
      <div role="group" aria-label="decision">
        <label>
          <input
            type="radio"
            name="approval"
            checked={current.approved}
            onChange={() => {
              onChange({ kind: "approval", approved: true, ...(reason ? { reason } : {}) });
            }}
          />
          Approve
        </label>
        <label>
          <input
            type="radio"
            name="approval"
            checked={!current.approved}
            onChange={() => {
              onChange({ kind: "approval", approved: false, ...(reason ? { reason } : {}) });
            }}
          />
          Reject
        </label>
      </div>
      <textarea
        aria-label="reason"
        placeholder="Reason (optional)"
        value={reason}
        onChange={(event) => {
          setReason(event.target.value);
          onChange({ kind: "approval", approved: current.approved, ...(event.target.value ? { reason: event.target.value } : {}) });
        }}
      />
      <button type="submit" disabled={submitting}>
        {current.approved ? "Approve" : "Reject"} and submit
      </button>
    </form>
  );
}

function TextForm({ question, draft, onChange, submitting, onSubmit }: DraftFormProps): React.JSX.Element {
  const current = draft as Extract<Answer, { kind: "text" }>;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit({ kind: "text", value: current.value });
      }}
    >
      <p>{question.body}</p>
      <textarea
        aria-label="answer"
        value={current.value}
        onChange={(event) => {
          onChange({ kind: "text", value: event.target.value });
        }}
      />
      <button type="submit" disabled={submitting || current.value.trim() === ""}>
        Submit answer
      </button>
    </form>
  );
}

function ChoiceForm({ question, draft, onChange, submitting, onSubmit }: DraftFormProps): React.JSX.Element {
  const current = draft as Extract<Answer, { kind: "choice" }>;
  const [other, setOther] = useState(current.other ?? "");
  const options = question.options ?? [];
  const toggle = (id: string): void => {
    const has = current.ids.includes(id);
    const ids = question.multi
      ? has
        ? current.ids.filter((candidate) => candidate !== id)
        : [...current.ids, id]
      : has
        ? []
        : [id];
    onChange({ kind: "choice", ids, ...(other ? { other } : {}) });
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit({ kind: "choice", ids: current.ids, ...(other ? { other } : {}) });
      }}
    >
      <p>{question.body}</p>
      <div role="group" aria-label="options">
        {options.map((option) => (
          <label key={option.id}>
            <input
              type={question.multi ? "checkbox" : "radio"}
              name="choice"
              checked={current.ids.includes(option.id)}
              onChange={() => toggle(option.id)}
            />
            {option.label}
            {option.description ? <small> — {option.description}</small> : null}
          </label>
        ))}
      </div>
      {question.allowOther ? (
        <textarea
          aria-label="other"
          placeholder="Other…"
          value={other}
          onChange={(event) => {
            setOther(event.target.value);
            onChange({ kind: "choice", ids: current.ids, ...(event.target.value ? { other: event.target.value } : {}) });
          }}
        />
      ) : null}
      <button type="submit" disabled={submitting}>
        Submit choice
      </button>
    </form>
  );
}
