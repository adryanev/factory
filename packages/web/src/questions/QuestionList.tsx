/**
 * The "Menunggu saya" surface (issue 13): every open Question whose audience
 * Group contains the caller, with an answering form each. The list is the
 * spec's badge-as-a-query (issue 19) — a cancelled or answered Question
 * disappears from the list because the underlying query stops matching.
 */
import { useCallback, useEffect, useState } from "react";
import type { Answer } from "@factory/shared";
import { fetchWaitingQuestions, submitAnswer, type QuestionState } from "./api";
import { AnswerForm } from "./AnswerForm";

export function QuestionList(): React.JSX.Element {
  const [questions, setQuestions] = useState<QuestionState[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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
          </li>
        ))}
      </ul>
    </section>
  );
}
