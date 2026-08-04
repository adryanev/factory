import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GrillingSession, type DraftRevision } from "../GrillingSession";
import type { QuestionState } from "../../questions/api";

function question(overrides: Partial<QuestionState> = {}): QuestionState {
  return {
    id: "question_1",
    stepRunId: "steprun_1",
    groupId: "product",
    kind: "edit-artifact",
    body: "Update the PRD directly",
    artifactKey: "prd",
    createdAt: "2026-01-01T00:00:00.000Z",
    answeredAt: null,
    answeredByPrincipalId: null,
    answer: null,
    stepRunOutcome: "awaiting-human",
    stepKey: "prd-grilling",
    branchKey: null,
    turn: 4,
    runId: "run_1",
    projectId: "project_1",
    projectName: "checkout",
    ...overrides,
  };
}

const revisions: DraftRevision[] = [
  { id: "r1", stepRunId: "steprun_1", turn: 3, content: "# First draft", authoredByPrincipalId: null },
  { id: "r2", stepRunId: "steprun_2", turn: 4, content: "# Human revision", authoredByPrincipalId: "user_1" },
];

describe("GrillingSession", () => {
  it("keeps conversation and draft visible, keeps Cancel Run without a Done action, and exposes the reopen query summary", () => {
    render(
      <GrillingSession
        question={question()}
        revisions={revisions}
        summary={{ draftRevisions: 2, humanEdits: 1, decisions: 3, openQuestions: 1 }}
      />,
    );

    expect(screen.getByRole("region", { name: "Conversation" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Draft and decisions" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel Run" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /done|finish|complete/i })).not.toBeInTheDocument();
    expect(screen.getByText(/draft revisions/)).toHaveTextContent("2 draft revisions");
    expect(screen.getByText(/decisions recorded/)).toHaveTextContent("3 decisions recorded");
    expect(screen.getByRole("note")).toHaveTextContent("ditulis user_1");
  });

  it("shows the decisions tab and always keeps the free-text box for a choice Question", async () => {
    const user = userEvent.setup();
    render(
      <GrillingSession
        question={question({
          kind: "choice",
          artifactKey: null,
          body: "Choose a rollout",
          options: [{ id: "safe", label: "Safe rollout" }],
          multi: false,
          allowOther: false,
        })}
        decisions={[{ id: "d1", turn: 2, question: "Who uses it?", answer: "Ops" }]}
      />,
    );

    expect(screen.getByLabelText("answer")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: /decisions/i }));
    expect(screen.getByText("Who uses it?")).toBeInTheDocument();
    expect(screen.getByText("Ops")).toBeInTheDocument();
  });

  it("makes the draft read-only for a non-holder", () => {
    render(<GrillingSession question={question()} revisions={revisions} canEdit={false} />);

    expect(screen.getByText(/only the answer-turn holder may edit/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit draft" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Inline draft editor" })).not.toBeInTheDocument();
  });

  it("confirms rewind from a turn and delegates creation of the child Run", async () => {
    const user = userEvent.setup();
    const onRewind = vi.fn(async () => undefined);
    render(
      <GrillingSession
        question={question()}
        messages={[{ id: "m1", turn: 2, actor: "agent", text: "What is the constraint?" }]}
        onRewind={onRewind}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Rewind from here" }));
    expect(screen.getByTestId("rewind-confirmation")).toHaveTextContent("parent_run_id");
    await user.click(screen.getByRole("button", { name: "Create child Run" }));
    expect(onRewind).toHaveBeenCalledWith("steprun_1", 2);
  });

  it("uses the stacked layout below the narrow-screen breakpoint", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(join(here, "..", "GrillingSession.css"), "utf8");
    expect(css).toContain("grid-template-columns: minmax(0, 1fr) minmax(0, 1.05fr)");
    expect(css).toContain("@media (max-width: 1080px)");
    expect(css).toContain(".grilling__layout {\n    display: block;");
  });
});
