/**
 * The web surface's root. Issue 13 adds the "Menunggu saya" surface — the
 * human-in-the-loop answering UI — on top of the scaffold; the monitoring and
 * grilling screens arrive in their own issues. Issue 20 adds the visual
 * Pipeline editor screen.
 */
import { useState } from "react";
import { QuestionList } from "./questions/QuestionList";
import { RunScreen } from "./runs/RunScreen";
import { PipelineEditor } from "./pipeline-editor/PipelineEditor";
import { CronSkipsScreen } from "./cron-skips/CronSkipsScreen";

function runRoute(pathname: string): { projectId: string; runId: string } | null {
  const match = pathname.match(/^\/projects\/([^/]+)\/runs\/([^/]+)(?:\/)?$/);
  return match?.[1] && match[2] ? { projectId: decodeURIComponent(match[1]), runId: decodeURIComponent(match[2]) } : null;
}

function pipelineEditorRoute(pathname: string): { projectId: string | null } | null {
  const match = pathname.match(/^\/projects\/([^/]+)\/pipeline-editor(?:\/)?$/);
  if (match?.[1]) {
    return { projectId: decodeURIComponent(match[1]) };
  }
  if (pathname === "/pipeline-editor") {
    return { projectId: null };
  }
  return null;
}

function cronSkipsRoute(pathname: string): { projectId: string } | null {
  const match = pathname.match(/^\/projects\/([^/]+)\/automation\/cron-skips(?:\/)?$/);
  return match?.[1] ? { projectId: decodeURIComponent(match[1]) } : null;
}

export function App(): React.JSX.Element {
  const [waitingQuestionCount, setWaitingQuestionCount] = useState(0);
  const route = typeof window === "undefined" ? null : runRoute(window.location.pathname);
  if (route) {
    return <RunScreen projectId={route.projectId} runId={route.runId} />;
  }
  const editorRoute = typeof window === "undefined" ? null : pipelineEditorRoute(window.location.pathname);
  if (editorRoute) {
    return <PipelineEditor projectId={editorRoute.projectId} />;
  }
  const skipsRoute = typeof window === "undefined" ? null : cronSkipsRoute(window.location.pathname);
  if (skipsRoute) {
    return <CronSkipsScreen projectId={skipsRoute.projectId} />;
  }
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
      <nav aria-label="pipeline editing">
        <a href="/pipeline-editor">Pipeline editor</a>
      </nav>
      <QuestionList onWaitingCountChange={setWaitingQuestionCount} />
    </main>
  );
}
