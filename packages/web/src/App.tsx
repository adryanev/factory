/**
 * The web surface's root. Issue 13 adds the "Menunggu saya" surface — the
 * human-in-the-loop answering UI — on top of the scaffold; the monitoring and
 * grilling screens arrive in their own issues.
 */
import { QuestionList } from "./questions/QuestionList";

export function App(): React.JSX.Element {
  return (
    <main>
      <h1>factory</h1>
      <QuestionList />
    </main>
  );
}
