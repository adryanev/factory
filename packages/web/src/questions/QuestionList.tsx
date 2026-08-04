/**
 * The "Menunggu saya" surface (issue 13): every open Question whose audience
 * Group contains the caller, with an answering form each. The list is the
 * spec's badge-as-a-query (issue 19) — a cancelled or answered Question
 * disappears from the list because the underlying query stops matching.
 */
import { useCallback, useEffect, useState } from "react";
import { generateId, type Answer } from "@factory/shared";
import {
  cancelRun,
  fetchArtifactContent,
  fetchGrillingSummary,
  fetchRun,
  fetchRunArtifacts,
  fetchWaitingQuestions,
  rewindRun,
  submitAnswer,
  type GrillingSummary,
  type QuestionState,
} from "./api";
import { AnswerForm } from "./AnswerForm";
import { GrillingSession, type DecisionEntry, type DraftRevision } from "../grilling/GrillingSession";

export function QuestionList(): React.JSX.Element {
  const [questions, setQuestions] = useState<QuestionState[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedQuestionId, setSelectedQuestionId] = useState<string | null>(null);
  const [sessionSummary, setSessionSummary] = useState<GrillingSummary | undefined>();
  const [sessionRevisions, setSessionRevisions] = useState<DraftRevision[] | undefined>();
  const [sessionDecisions, setSessionDecisions] = useState<DecisionEntry[] | undefined>();

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setQuestions(await fetchWaitingQuestions());
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const selected = questions?.find((question) => question.id === selectedQuestionId);
    if (!selected) return;
    let active = true;
    setSessionSummary(undefined);
    setSessionRevisions(undefined);
    setSessionDecisions(undefined);
    void Promise.all([
      fetchGrillingSummary(selected.projectId, selected.runId),
      fetchRunArtifacts(selected.projectId, selected.runId, selected.artifactKey ?? "prd"),
      fetchRun(selected.projectId, selected.runId),
    ])
      .then(async ([summary, artifactMeta, run]) => {
        const revisions = await Promise.all(
          artifactMeta.map(async (artifact): Promise<DraftRevision | null> => {
            try {
              return {
                id: artifact.id,
                stepRunId: artifact.stepRunId,
                turn: artifact.turn,
                content: await fetchArtifactContent(artifact.id),
                authoredByPrincipalId: artifact.authoredByPrincipalId,
              };
            } catch {
              return null;
            }
          }),
        );
        const decisions: DecisionEntry[] = [];
        for (const stepRun of run.stepRuns) {
          const outputData = stepRun.outputData;
          const raw =
            typeof outputData === "object" && outputData !== null && Array.isArray((outputData as { decisions?: unknown }).decisions)
              ? (outputData as { decisions: unknown[] }).decisions
              : [];
          for (const [index, decision] of raw.entries()) {
            if (typeof decision !== "object" || decision === null) continue;
            const value = decision as { question?: unknown; answer?: unknown; rationale?: unknown };
            if (typeof value.question !== "string" || typeof value.answer !== "string") continue;
            decisions.push({
              id: `${stepRun.id}-decision-${index}`,
              turn: stepRun.turn,
              question: value.question,
              answer: value.answer,
              ...(typeof value.rationale === "string" ? { rationale: value.rationale } : {}),
            });
          }
        }
        if (!active) return;
        setSessionSummary(summary);
        setSessionRevisions(revisions.filter((revision): revision is DraftRevision => revision !== null).reverse());
        setSessionDecisions(decisions);
      })
      .catch(() => {
        // The session remains usable with its current Question if optional
        // history queries fail; the answering CAS is the critical path.
      });
    return () => {
      active = false;
    };
  }, [questions, selectedQuestionId]);

  const handleSubmit = useCallback(
    (questionId: string) => (answer: Answer) => submitAnswer(questionId, answer),
    [],
  );

  if (error !== null) {
    return <p role="alert">Could not load questions: {error}</p>;
  }
  if (questions === null) {
    return <p aria-busy="true">Loading…</p>;
  }
  if (questions.length === 0) {
    return <p>Nothing waiting for you.</p>;
  }

  const selectedQuestion = questions.find((question) => question.id === selectedQuestionId);
  if (selectedQuestion) {
    return (
      <section>
        <button type="button" onClick={() => setSelectedQuestionId(null)}>Back to waiting questions</button>
        <GrillingSession
          question={selectedQuestion}
          {...(sessionSummary ? { summary: sessionSummary } : {})}
          {...(sessionRevisions ? { revisions: sessionRevisions } : {})}
          {...(sessionDecisions ? { decisions: sessionDecisions } : {})}
          onSubmit={handleSubmit(selectedQuestion.id)}
          onAnswered={() => {
            setSelectedQuestionId(null);
            void refresh();
          }}
          onCancelRun={async () => {
            await cancelRun(selectedQuestion.projectId, selectedQuestion.runId);
            setSelectedQuestionId(null);
            await refresh();
          }}
          onRewind={async (stepRunId) => {
            await rewindRun(selectedQuestion.projectId, selectedQuestion.runId, stepRunId, generateId("run"));
            setSelectedQuestionId(null);
            await refresh();
          }}
        />
      </section>
    );
  }

  return (
    <section aria-label="Questions waiting for you">
      <h2>Menunggu saya</h2>
      <ul style={{ listStyle: "none", padding: 0 }}>
        {questions.map((question) => (
          <li key={question.id}>
            <header>
              <span>{question.projectName}</span>
              {" · "}
              <code>{question.stepKey}</code>
              {" · giliran "}
              {question.turn}
            </header>
            <AnswerForm question={question} onSubmit={handleSubmit(question.id)} onAnswered={() => void refresh()} />
            <button type="button" onClick={() => setSelectedQuestionId(question.id)}>Open grilling session</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
