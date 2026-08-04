/** The web surface's root. Run URLs are resolved without adding a router dependency. */
import { QuestionList } from "./questions/QuestionList";
import { RunScreen } from "./runs/RunScreen";

function runRoute(pathname: string): { projectId: string; runId: string } | null {
  const match = pathname.match(/^\/projects\/([^/]+)\/runs\/([^/]+)(?:\/)?$/);
  return match?.[1] && match[2] ? { projectId: decodeURIComponent(match[1]), runId: decodeURIComponent(match[2]) } : null;
}

export function App(): React.JSX.Element {
  const route = typeof window === "undefined" ? null : runRoute(window.location.pathname);
  if (route) {
    return <RunScreen projectId={route.projectId} runId={route.runId} />;
  }
  return (
    <main>
      <h1>factory</h1>
      <QuestionList />
    </main>
  );
}
