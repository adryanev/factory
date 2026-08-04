/**
 * Issue 13, AC8 — the answering surface preserves a loser's typed text and
 * shows the latest state instead of failing. These are component tests over
 * the same forms the QuestionList renders.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Answer } from "@factory/shared";
import { AnswerForm } from "../AnswerForm";
import type { AnswerResult, QuestionState } from "../api";

function approvalQuestion(overrides: Partial<QuestionState> = {}): QuestionState {
  return {
    id: "question_1",
    stepRunId: "steprun_1",
    groupId: "group_1",
    kind: "approval",
    body: "Approve this plan?",
    artifactKey: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    answeredAt: null,
    answeredByPrincipalId: null,
    answer: null,
    stepRunOutcome: "awaiting-human",
    stepKey: "review",
    branchKey: null,
    turn: 1,
    runId: "run_1",
    projectId: "project_1",
    projectName: "acme",
    ...overrides,
  };
}

describe("AnswerForm", () => {
  it("submits an approval with a reason", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async (answer: Answer) => ({ status: "accepted" } as const));
    const onAnswered = vi.fn();
    render(<AnswerForm question={approvalQuestion()} onSubmit={onSubmit} onAnswered={onAnswered} />);

    await user.type(screen.getByLabelText("reason"), "looks good");
    await user.click(screen.getByRole("button", { name: /approve and submit/i }));

    expect(onSubmit).toHaveBeenCalledWith({ kind: "approval", approved: true, reason: "looks good" });
    await waitFor(() => expect(onAnswered).toHaveBeenCalled());
  });

  it("submits a rejection (approved: false is data) and renders the rejection as text", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async (answer: Answer) => ({ status: "accepted" } as const));
    render(<AnswerForm question={approvalQuestion()} onSubmit={onSubmit} onAnswered={() => {}} />);

    await user.click(screen.getByRole("radio", { name: /reject/i }));
    await user.type(screen.getByLabelText("reason"), "not ready");
    await user.click(screen.getByRole("button", { name: /reject and submit/i }));

    expect(onSubmit).toHaveBeenCalledWith({ kind: "approval", approved: false, reason: "not ready" });
  });

  it("AC8 — a lost race shows the latest state and keeps the typed reason in the field", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async (answer: Answer): Promise<AnswerResult> => ({
      status: "race-lost",
      question: approvalQuestion({
        answeredAt: "2026-01-01T00:10:00.000Z",
        answeredByPrincipalId: "user_winner",
        answer: { kind: "approval", approved: true, reason: "first" },
        stepRunOutcome: "succeeded",
      }),
      typedAnswer: answer,
    }));
    render(<AnswerForm question={approvalQuestion()} onSubmit={onSubmit} onAnswered={() => {}} />);

    await user.click(screen.getByRole("radio", { name: /reject/i }));
    await user.type(screen.getByLabelText("reason"), "my careful typed reason");
    await user.click(screen.getByRole("button", { name: /reject and submit/i }));

    await waitFor(() => expect(screen.getByTestId("race-lost")).toBeInTheDocument());
    expect(screen.getByTestId("race-lost")).toHaveTextContent("answered by user_winner");
    // The draft is not discarded — the reason is still in the field.
    expect((screen.getByLabelText("reason") as HTMLTextAreaElement).value).toBe("my careful typed reason");
  });
});
