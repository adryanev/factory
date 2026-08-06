/**
 * Issue 13, AC9/AC6 — the "Menunggu saya" list renders the open Questions for
 * the caller's Groups and clears them once answered. Fetch is mocked; the
 * control plane's real answering write is covered by the seam-1 suite.
 */
import { describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QuestionList } from "../QuestionList";

function question(id: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    stepRunId: `steprun_${id}`,
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

function urlOf(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function mockFetchWaiting(questions: unknown[]): ReturnType<typeof vi.fn> {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = urlOf(input);
    if (url.endsWith("/questions/waiting")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ questions }),
        text: async () => JSON.stringify({ questions }),
      };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
  });
  vi.stubGlobal("fetch", fetchImpl);
  return fetchImpl;
}

describe("QuestionList", () => {
  it("renders each open Question with its step context and an answering form", async () => {
    mockFetchWaiting([
      question("question_1"),
      question("question_2", { kind: "text", body: "Which way?", projectName: "globex" }),
    ]);
    render(<QuestionList />);

    await waitFor(() => expect(screen.getByText("Approve this plan?")).toBeInTheDocument());
    expect(screen.getByText("Which way?")).toBeInTheDocument();
    expect(screen.getByText("acme")).toBeInTheDocument();
    expect(screen.getByText("globex")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /submit/i }).length).toBeGreaterThan(0);
  });

  it("renders an empty state when nothing is waiting", async () => {
    mockFetchWaiting([]);
    render(<QuestionList />);
    await waitFor(() => expect(screen.getByText("Nothing waiting for you.")).toBeInTheDocument());
  });

  it("preserves oldest-first order and shows each Question's age", async () => {
    mockFetchWaiting([
      question("newer", { projectName: "newer-project", createdAt: "2026-01-01T01:00:00.000Z" }),
      question("older", { projectName: "older-project", createdAt: "2026-01-01T00:00:00.000Z" }),
    ]);
    render(<QuestionList />);

    await waitFor(() => expect(screen.getByText("older-project")).toBeInTheDocument());
    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("newer-project");
    expect(items[0]).toHaveTextContent("old");
    expect(items[1]).toHaveTextContent("older-project");
    expect(items[1]).toHaveTextContent("old");
  });

  it("reports the fetched state to the app badge without a badge request", async () => {
    const fetchImpl = mockFetchWaiting([question("question_1"), question("question_2")]);
    const onWaitingCountChange = vi.fn();
    render(<QuestionList onWaitingCountChange={onWaitingCountChange} />);

    await waitFor(() => expect(screen.getAllByText("Approve this plan?")).toHaveLength(2));
    expect(onWaitingCountChange).toHaveBeenLastCalledWith(2);
    expect(fetchImpl.mock.calls.every(([input]) => urlOf(input).endsWith("/questions/waiting"))).toBe(true);
  });

  it("uses one slow refresh for a non-Run tab", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = mockFetchWaiting([question("question_1")]);
      render(<QuestionList />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      await act(async () => {
        vi.advanceTimersByTime(29_999);
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      await act(async () => {
        vi.advanceTimersByTime(1);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an accepted answer refreshes the list", async () => {
    const fetchImpl = vi
      .fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.endsWith("/questions/waiting")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ questions: [question("question_1")] }),
            text: async () => JSON.stringify({ questions: [question("question_1")] }),
          };
        }
        return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
      });
    vi.stubGlobal("fetch", fetchImpl);
    const user = userEvent.setup();
    render(<QuestionList />);
    await waitFor(() => expect(screen.getByRole("button", { name: /approve and submit/i })).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /approve and submit/i }));

    // A second /questions/waiting fetch proves the answer triggered a refresh.
    await waitFor(() => {
      const waitingCalls = fetchImpl.mock.calls.filter(([input]) => urlOf(input).endsWith("/questions/waiting"));
      expect(waitingCalls.length).toBeGreaterThanOrEqual(2);
    });
  });
});
