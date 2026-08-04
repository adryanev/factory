/**
 * The web surface's root. Issue 13 adds the "Menunggu saya" surface — the
 * human-in-the-loop answering UI — on top of the scaffold; the monitoring and
 * grilling screens arrive in their own issues.
 */
import { useState } from "react";
import { QuestionList } from "./questions/QuestionList";

export function App(): React.JSX.Element {
  const [waitingQuestionCount, setWaitingQuestionCount] = useState(0);

  return (
    <main>
      <header>
        <h1>factory</h1>
        <a href="/questions/waiting" aria-label="Questions waiting for you">
          Menunggu saya{" "}
          <span role="status" aria-label={`${waitingQuestionCount} questions waiting`}>
            {waitingQuestionCount}
          </span>
        </a>
      </header>
      <QuestionList onWaitingCountChange={setWaitingQuestionCount} />
    </main>
  );
}
