import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RunScreen } from "../RunScreen";
import {
  cancelRun,
  fetchLogChunk,
  fetchLogTail,
  fetchRun,
  fetchRunCost,
  fetchStepRunArtifacts,
} from "../api";
import type { RunDetail, RunPollResult, StepRunRecord } from "../api";

vi.mock("../api", () => ({
  cancelRun: vi.fn(),
  fetchLogChunk: vi.fn(),
  fetchLogTail: vi.fn(),
  fetchRun: vi.fn(),
  fetchRunCost: vi.fn(),
  fetchStepRunArtifacts: vi.fn(),
}));

const RUN_ID = "run_01hmonitoring";
const PROJECT_ID = "project_01monitoring";

function stepRun(
  stepKey: string,
  branchKey: string | null,
  outcome: StepRunRecord["outcome"],
  overrides: Partial<StepRunRecord> = {},
): StepRunRecord {
  return {
    id: `steprun_${stepKey}_${branchKey ?? "root"}`,
    runId: RUN_ID,
    repositoryId: "repository_backend",
    stepKey,
    branchKey,
    turn: 1,
    attempt: 1,
    outcome,
    reason: null,
    kind: null,
    requiredTags: [],
    readyAt: "2026-08-04T08:00:00.000Z",
    startedAt: outcome === "running" ? "2026-08-04T08:01:00.000Z" : null,
    outputRefBranch: null,
    outputRefSha: null,
    outputData: null,
    prNumber: null,
    prUrl: null,
    finalPrompt: null,
    ...overrides,
  };
}

function definition(includeReview = true): string {
  return `version: 1
name: Checkout monitor
repo: backend
concurrency: review
steps:
  plan:
    run: echo plan
  implement:
    after: [plan]
    prompt: implement the plan
    branches:
${Array.from({ length: 10 }, (_, index) => `      - key: agent-${index + 1}`).join("\n")}
  pick:
    after: [implement]
    join: any
    run: echo pick
${includeReview ? "  review:\n    after: [pick]\n    prompt: review the result\n    ask:\n      group: reviewers\n      kind: approval\n" : ""}`;
}

function detail(stepRuns: StepRunRecord[], includeReview = true): RunDetail {
  return {
    run: {
      id: RUN_ID,
      projectId: PROJECT_ID,
      pipelineRepositoryId: "repository_backend",
      pipelinePath: ".factory/pipeline.yaml",
      triggerKind: "manual",
      triggeredByPrincipalId: "user_01monitoring",
      credentialPrincipalId: "user_01monitoring",
      refBranch: "main",
      refSha: "abc1234",
      parentRunId: null,
      cancelRequestedAt: null,
      outcome: null,
      endedAt: null,
      definition: definition(includeReview),
      definitionFiles: {},
    },
    stepRuns,
  };
}

function fanOutRuns(): StepRunRecord[] {
  const statuses: StepRunRecord["outcome"][] = [
    "failed",
    "awaiting-human",
    "ready",
    "running",
    "succeeded",
    "succeeded",
    "succeeded",
    "succeeded",
    "succeeded",
    "succeeded",
  ];
  return [
    stepRun("plan", null, "succeeded"),
    ...statuses.map((status, index) => stepRun("implement", `agent-${index + 1}`, status, {
      turn: index === 0 ? 4 : 1,
      attempt: index === 0 ? 2 : 1,
      reason: index === 0 ? "output-invalid" : null,
      readyAt: status === "ready" ? "2026-08-04T07:50:00.000Z" : "2026-08-04T08:00:00.000Z",
    })),
    stepRun("pick", null, "ready"),
  ];
}

const notModified: RunPollResult = { status: "not-modified", etag: '"fixture"' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchRun).mockResolvedValue(notModified);
  vi.mocked(fetchRunCost).mockRejectedValue(new Error("cost not in fixture"));
  vi.mocked(fetchLogTail).mockResolvedValue({ chunks: [], nextOffset: 0, attempt: 1, ended: true });
  vi.mocked(fetchLogChunk).mockResolvedValue("");
  vi.mocked(fetchStepRunArtifacts).mockResolvedValue([]);
});

describe("RunScreen", () => {
  it("opens on the Graph with a persistent right inspector and no StepRun link", () => {
    render(<RunScreen projectId={PROJECT_ID} runId={RUN_ID} initialData={detail(fanOutRuns())} />);

    expect(screen.getByRole("region", { name: "Run graph" })).toBeInTheDocument();
    expect(screen.getByTestId("run-layout")).toHaveAttribute("data-layout", "desktop-right-mobile-stack");
    expect(screen.getByTestId("run-inspector")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /StepRun|agent-1/i })).not.toBeInTheDocument();
  });

  it("keeps the canvas and inspector as accessible siblings for desktop and mobile stacking", () => {
    render(<RunScreen projectId={PROJECT_ID} runId={RUN_ID} initialData={detail([stepRun("plan", null, "running")], false)} />);

    const layout = screen.getByTestId("run-layout");
    expect(layout.children[0]).toHaveClass("run-canvas");
    expect(layout.children[1]).toHaveAttribute("data-testid", "run-inspector");
    expect(layout).toHaveAttribute("data-layout", "desktop-right-mobile-stack");
  });

  it("summarizes more than eight branches by blocking status, keeping the failed branch visible", () => {
    render(<RunScreen projectId={PROJECT_ID} runId={RUN_ID} initialData={detail(fanOutRuns(), false)} />);

    const graphNode = screen.getByTestId("graph-node-implement");
    const branchButtons = within(graphNode).getAllByRole("button", { name: /agent-/i });
    expect(branchButtons).toHaveLength(8);
    expect(branchButtons[0]).toHaveAccessibleName(/agent-1/i);
    expect(branchButtons[1]).toHaveAccessibleName(/agent-2/i);
    expect(branchButtons[2]).toHaveAccessibleName(/agent-3/i);
    expect(within(graphNode).getByText("…2 cabang lain")).toBeInTheDocument();
  });

  it("keeps failed and skipped status shapes and labels independent of color", () => {
    const runs = [
      stepRun("plan", null, "failed"),
      stepRun("pick", null, "skipped"),
    ];
    render(<RunScreen projectId={PROJECT_ID} runId={RUN_ID} initialData={detail(runs, false)} />);

    const failed = screen.getAllByRole("img", { name: "Failed" })[0];
    const skipped = screen.getAllByRole("img", { name: "Skipped" })[0];
    expect(failed).toHaveAttribute("data-shape", "cross");
    expect(skipped).toHaveAttribute("data-shape", "slash");
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("Skipped")).toBeInTheDocument();
  });

  it("raises only a real blocker, not a failed branch beneath Join any", () => {
    const runs = [
      stepRun("plan", null, "succeeded"),
      stepRun("implement", "agent-1", "failed", { reason: "agent failed" }),
      stepRun("pick", null, "ready"),
      stepRun("review", null, "awaiting-human", { turn: 4 }),
    ];
    render(<RunScreen projectId={PROJECT_ID} runId={RUN_ID} initialData={detail(runs)} />);

    expect(screen.getByTestId("blocking-banner")).toHaveAttribute("data-blocker-kind", "awaiting-human");
    expect(screen.getByText(/waiting for a human at review/i)).toBeInTheDocument();
    expect(screen.queryByText(/failed and is holding the Run/i)).not.toBeInTheDocument();
  });

  it("marks a ready StepRun stale after five minutes and keeps the long turn notation", async () => {
    const user = userEvent.setup();
    const runs = fanOutRuns();
    render(
      <RunScreen
        projectId={PROJECT_ID}
        runId={RUN_ID}
        initialData={detail(runs, false)}
        now={() => Date.parse("2026-08-04T08:00:00.000Z")}
      />,
    );

    expect(screen.getByTestId("blocking-banner")).toHaveAttribute("data-blocker-kind", "unscheduled");
    expect(screen.getByText(/Unscheduled for 10m/)).toBeInTheDocument();
    await user.click(within(screen.getByTestId("graph-node-implement")).getByRole("button", { name: /agent-1/i }));
    await user.click(screen.getByRole("tab", { name: "Info" }));
    expect(screen.getByText("giliran 4 · attempt 2")).toBeInTheDocument();
    expect(screen.getByText(`run/${RUN_ID}/implement/agent-1/t4-a2`)).toBeInTheDocument();
  });

  it("exposes one log tab per branch and never a combined stream", () => {
    render(<RunScreen projectId={PROJECT_ID} runId={RUN_ID} initialData={detail(fanOutRuns(), false)} />);

    expect(screen.getByRole("tab", { name: "agent-1" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "agent-2" })).toBeInTheDocument();
    expect(screen.queryByText(/combined|merged/i)).not.toBeInTheDocument();
  });

  it("acknowledges cancel intent before the server request resolves", async () => {
    const user = userEvent.setup();
    let resolveCancel: ((run: RunDetail["run"]) => void) | undefined;
    vi.mocked(cancelRun).mockImplementation(
      () => new Promise((resolve) => {
        resolveCancel = resolve;
      }),
    );
    const initial = detail([stepRun("plan", null, "running")], false);
    render(<RunScreen projectId={PROJECT_ID} runId={RUN_ID} initialData={initial} />);

    await user.click(screen.getByRole("button", { name: "Cancel Run" }));
    await user.click(screen.getByRole("button", { name: "Confirm cancel" }));
    expect(screen.getByTestId("cancel-intent")).toHaveTextContent(/Cancellation requested/i);
    expect(cancelRun).toHaveBeenCalledWith(PROJECT_ID, RUN_ID);
    resolveCancel?.({ ...initial.run, cancelRequestedAt: "2026-08-04T08:00:00.000Z" });
  });
});
