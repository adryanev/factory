import { useEffect, useState } from "react";
import type { Answer, Decision } from "@factory/shared";
import { HumanAuthoredMark } from "../primitives/HumanAuthoredMark";
import { AnswerForm } from "../questions/AnswerForm";
import type { AnswerResult, QuestionState } from "../questions/api";
import "./GrillingSession.css";

export interface ConversationEntry {
  id: string;
  turn: number;
  actor: "agent" | "human" | "system";
  text: string;
  author?: string;
}

export interface DraftRevision {
  id: string;
  stepRunId: string;
  turn: number;
  content: string;
  authoredByPrincipalId: string | null;
}

export interface DecisionEntry extends Decision {
  id: string;
  turn: number;
}

export interface ReopenSummary {
  draftRevisions: number;
  humanEdits: number;
  decisions: number;
  openQuestions: number;
}

export interface GrillingSessionProps {
  question: QuestionState;
  messages?: ConversationEntry[];
  revisions?: DraftRevision[];
  decisions?: DecisionEntry[];
  summary?: ReopenSummary;
  currentPrincipalId?: string;
  canEdit?: boolean;
  runLabel?: string;
  stepLabel?: string;
  onSubmit?: (answer: Answer) => Promise<AnswerResult>;
  onAnswered?: () => void;
  onCancelRun?: () => Promise<void> | void;
  onRewind?: (stepRunId: string, turn: number) => Promise<void> | void;
}

const EMPTY_SUMMARY: ReopenSummary = {
  draftRevisions: 0,
  humanEdits: 0,
  decisions: 0,
  openQuestions: 1,
};

const DEFAULT_DRAFT: DraftRevision = {
  id: "draft-current",
  stepRunId: "draft-current-step-run",
  turn: 1,
  content: "# Product requirements\n\nThe draft will grow as the conversation continues.",
  authoredByPrincipalId: null,
};
const DEFAULT_REVISIONS = [DEFAULT_DRAFT];

const accepted: AnswerResult = { status: "accepted" };

function defaultSubmit(): Promise<AnswerResult> {
  return Promise.resolve(accepted);
}

function answerTurnText(question: QuestionState): string {
  switch (question.kind) {
    case "choice":
      return "Choice + text";
    case "approval":
      return "Approval";
    case "edit-artifact":
      return "Edit artifact";
    case "text":
      return "Text";
  }
}

function revisionLabel(revision: DraftRevision): string {
  return `Turn ${revision.turn}${revision.authoredByPrincipalId ? ` · ${revision.authoredByPrincipalId}` : ""}`;
}

export function GrillingSession({
  question,
  messages = [],
  revisions = DEFAULT_REVISIONS,
  decisions = [],
  summary = EMPTY_SUMMARY,
  currentPrincipalId,
  canEdit = true,
  runLabel = question.runId,
  stepLabel = question.stepKey,
  onSubmit = defaultSubmit,
  onAnswered = () => undefined,
  onCancelRun,
  onRewind,
}: GrillingSessionProps): React.JSX.Element {
  const [rightTab, setRightTab] = useState<"draft" | "decisions">("draft");
  const [selectedRevisionId, setSelectedRevisionId] = useState(revisions.at(-1)?.id ?? DEFAULT_DRAFT.id);
  const [editing, setEditing] = useState(false);
  const [draftContent, setDraftContent] = useState(revisions.at(-1)?.content ?? DEFAULT_DRAFT.content);
  const [savingDraft, setSavingDraft] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [rewindTurn, setRewindTurn] = useState<number | null>(null);

  useEffect(() => {
    const latest = revisions.at(-1);
    if (!latest) return;
    setSelectedRevisionId(latest.id);
    setDraftContent(latest.content);
  }, [revisions]);

  const latestRevision = revisions.at(-1) ?? DEFAULT_DRAFT;
  const selectedRevision = revisions.find((revision) => revision.id === selectedRevisionId) ?? latestRevision;
  const isLatestRevision = selectedRevision.id === latestRevision.id;
  const editable = canEdit && isLatestRevision;
  const hasReturnSummary = summary.draftRevisions + summary.humanEdits + summary.decisions + summary.openQuestions > 0;

  const saveDraft = async (): Promise<void> => {
    if (!editable || draftContent.trim() === "") return;
    setSavingDraft(true);
    try {
      if (question.kind === "edit-artifact") {
        const result = await onSubmit({ kind: "edit-artifact", content: draftContent });
        if (result.status === "accepted") {
          onAnswered();
          setEditing(false);
        }
        return;
      }
      setEditing(false);
    } finally {
      setSavingDraft(false);
    }
  };

  const cancelRun = async (): Promise<void> => {
    if (!onCancelRun) return;
    setCanceling(true);
    try {
      await onCancelRun();
    } finally {
      setCanceling(false);
    }
  };

  const confirmRewind = async (): Promise<void> => {
    if (!onRewind || rewindTurn === null) return;
    const target = messages.find((message) => message.turn === rewindTurn);
    if (!target) return;
    await onRewind(question.stepRunId, target.turn);
    setRewindTurn(null);
  };

  return (
    <main className="grilling" data-testid="grilling-session">
      <header className="grilling__topbar">
        <div className="grilling__brand"><span aria-hidden="true" className="grilling__brand-mark" />factory</div>
        <div className="grilling__crumbs">
          <span>{runLabel}</span><span aria-hidden="true">/</span><strong>{stepLabel}</strong>
        </div>
        <div className="grilling__top-actions">
          <button type="button" className="button button--danger" onClick={() => void cancelRun()} disabled={canceling}>
            {canceling ? "Canceling..." : "Cancel Run"}
          </button>
        </div>
      </header>

      <section className="grilling__heading">
        <div>
          <h1>Product requirements</h1>
          <p>Conversation and draft stay together while the agent turns answers into a usable artifact.</p>
        </div>
        <div className="grilling__facts" aria-label="session facts">
          <span><b>Turn {question.turn}</b></span>
          <span>{answerTurnText(question)}</span>
          <span>Group {question.groupId}</span>
        </div>
      </section>

      {hasReturnSummary ? (
        <section className="grilling__return" aria-label="While you were away">
          <div>
            <strong>While you were away</strong>
            <p>The counts below are queries over the Run history. They change when another answerer changes the state.</p>
          </div>
          <div className="grilling__summary">
            <span><b>{summary.draftRevisions}</b> draft revisions</span>
            <span><b>{summary.humanEdits}</b> human edits</span>
            <span><b>{summary.decisions}</b> decisions recorded</span>
            <span><b>{summary.openQuestions}</b> open questions</span>
          </div>
        </section>
      ) : null}

      {rewindTurn !== null ? (
        <section className="grilling__confirm" data-testid="rewind-confirmation">
          <strong>Rewind from turn {rewindTurn}?</strong>
          <p>This creates a new Run with <code>parent_run_id</code>. The old Run and its Artifacts stay intact.</p>
          <div className="grilling__confirm-actions">
            <button type="button" className="button button--danger-solid" onClick={() => void confirmRewind()}>Create child Run</button>
            <button type="button" className="button" onClick={() => setRewindTurn(null)}>Cancel</button>
          </div>
        </section>
      ) : null}

      <div className="grilling__layout">
        <section className="grilling__pane grilling__conversation" aria-label="Conversation">
          <div className="grilling__pane-header">
            <span className="grilling__pane-title">Conversation <small>{messages.length} messages</small></span>
            <span className="grilling__turn-badge">{canEdit ? "Your turn" : "Read only"}</span>
          </div>
          <div className="grilling__scroll grilling__messages">
            {messages.length === 0 ? (
              <div className="grilling__empty">The conversation starts with the current Question.</div>
            ) : null}
            {messages.map((message) => (
              <article className={`grilling__message grilling__message--${message.actor}`} key={message.id}>
                <div className="grilling__message-meta">
                  <strong>{message.actor === "agent" ? "Agent" : message.actor === "system" ? "Factory" : message.author ?? "Human"}</strong>
                  <span>turn {message.turn}</span>
                  {onRewind && message.actor !== "system" ? (
                    <button type="button" className="button button--quiet grilling__rewind" onClick={() => setRewindTurn(message.turn)}>
                      Rewind from here
                    </button>
                  ) : null}
                </div>
                <div className="grilling__bubble">{message.text}</div>
              </article>
            ))}
            <article className="grilling__message grilling__message--agent grilling__message--live">
              <div className="grilling__message-meta"><strong>Agent</strong><span>turn {question.turn}</span></div>
              <div className="grilling__bubble">{question.body}<span className="grilling__kind">kind {question.kind}</span></div>
            </article>
          </div>
          <div className="grilling__composer">
            <AnswerForm question={question} onSubmit={onSubmit} onAnswered={onAnswered} />
          </div>
        </section>

        <section className="grilling__pane grilling__draft" aria-label="Draft and decisions">
          <div className="grilling__pane-header">
            <div className="grilling__tabs" role="tablist" aria-label="Draft panel">
              <button type="button" role="tab" aria-selected={rightTab === "draft"} onClick={() => setRightTab("draft")}>Draft</button>
              <button type="button" role="tab" aria-selected={rightTab === "decisions"} onClick={() => setRightTab("decisions")}>Decisions <small>{decisions.length}</small></button>
            </div>
            <span className="grilling__draft-meta">{revisions.length} revisions</span>
          </div>
          {rightTab === "draft" ? (
            <>
              <div className="grilling__revisions" aria-label="Artifact history">
                {revisions.map((revision) => (
                  <button
                    type="button"
                    key={revision.id}
                    className={revision.authoredByPrincipalId ? "grilling__revision grilling__revision--human" : "grilling__revision"}
                    aria-pressed={revision.id === selectedRevision.id}
                    onClick={() => {
                      setSelectedRevisionId(revision.id);
                      setDraftContent(revision.content);
                      setEditing(false);
                    }}
                  >
                    {revisionLabel(revision)}
                  </button>
                ))}
              </div>
              <div className="grilling__scroll grilling__paper-wrap">
                <article className="grilling__paper">
                  {!isLatestRevision ? <p className="grilling__readonly-note">This Artifact is immutable history. Select the latest revision to edit.</p> : null}
                  {!canEdit ? <p className="grilling__readonly-note">You can read this draft, but only the answer-turn holder may edit it.</p> : null}
                  <div className="grilling__paper-stamp">
                    <code>Artifact {question.artifactKey ?? "prd"}</code>
                    <span>turn {selectedRevision.turn}</span>
                    {selectedRevision.authoredByPrincipalId ? <HumanAuthoredMark by={selectedRevision.authoredByPrincipalId} /> : null}
                  </div>
                  {editing && editable ? (
                    <textarea
                      className="grilling__draft-editor"
                      aria-label="Inline draft editor"
                      value={draftContent}
                      onChange={(event) => setDraftContent(event.target.value)}
                    />
                  ) : (
                    <pre className="grilling__document">{selectedRevision.content}</pre>
                  )}
                  {editing && editable ? (
                    <div className="grilling__editor-actions">
                      <button type="button" className="button" onClick={() => setEditing(false)}>Cancel</button>
                      <button type="button" className="button button--primary" disabled={savingDraft} onClick={() => void saveDraft()}>
                        {savingDraft ? "Saving..." : "Save as new Artifact"}
                      </button>
                    </div>
                  ) : editable ? (
                    <button type="button" className="button grilling__edit-button" onClick={() => setEditing(true)}>Edit draft</button>
                  ) : null}
                </article>
              </div>
            </>
          ) : (
            <div className="grilling__scroll grilling__decisions" role="tabpanel">
              {decisions.length === 0 ? <p className="grilling__empty">No agent-generated decisions have been recorded yet.</p> : null}
              {decisions.map((decision) => (
                <button type="button" className="grilling__decision" key={decision.id}>
                  <span><small>{decision.question}</small><strong>{decision.answer}</strong>{decision.rationale ? <em>{decision.rationale}</em> : null}</span>
                  <code>turn {decision.turn}</code>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
      <span className="grilling__principal" data-current-principal={currentPrincipalId ?? ""} aria-hidden="true" />
    </main>
  );
}
