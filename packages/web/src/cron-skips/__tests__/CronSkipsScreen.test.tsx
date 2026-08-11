/**
 * Issue 18, AC "pelewatannya terlihat di UI" — the cron-skips screen renders
 * every skipped cron fire with its reason, and pages keyset-style through the
 * same endpoint the control plane serves. Fetch is mocked; the seam-1 suite
 * covers the real endpoint.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CronSkipsScreen } from "../CronSkipsScreen";

const PROJECT_ID = "project_automation";

function skip(id: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    projectId: PROJECT_ID,
    pipelineRepositoryId: "repository_backend",
    pipelinePath: ".factory/pipeline.yaml",
    refBranch: "main",
    refSha: "abcdef1234567890",
    scheduledFor: "2026-08-11T01:00:00.000Z",
    skippedAt: "2026-08-11T01:00:00.000Z",
    reason: "run-active",
    ...overrides,
  };
}

function urlOf(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function mockFetchPages(pages: unknown[][]): ReturnType<typeof vi.fn> {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = urlOf(input);
    const calls = fetchImpl.mock.calls.filter(([callInput]) => urlOf(callInput).startsWith("/projects/"));
    const index = url.startsWith("/projects/") ? Math.min(calls.length - 1, pages.length - 1) : 0;
    const skips = pages[index] ?? [];
    const nextCursor = index < pages.length - 1 ? (skips[skips.length - 1] as { id: string }).id : null;
    return {
      ok: true,
      status: 200,
      json: async () => ({ skips, nextCursor }),
      text: async () => JSON.stringify({ skips, nextCursor }),
    };
  });
  return fetchImpl;
}

describe("CronSkipsScreen", () => {
  it("renders each skipped cron fire with its reason and the (Pipeline, ref) that overlapped", async () => {
    const fetchImpl = mockFetchPages([[skip("skip_1")]]);
    vi.stubGlobal("fetch", fetchImpl);

    render(<CronSkipsScreen projectId={PROJECT_ID} />);

    expect(fetchImpl).toHaveBeenCalledWith(
      `/projects/${PROJECT_ID}/automation/cron-skips`,
    );
    expect(await screen.findByText(".factory/pipeline.yaml")).toBeInTheDocument();
    expect(screen.getByText("main @ abcdef1")).toBeInTheDocument();
    expect(screen.getByText(/A Run was already active for the same Pipeline and ref/)).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("shows the empty state when no cron fire has been skipped", async () => {
    vi.stubGlobal("fetch", mockFetchPages([[]]));

    render(<CronSkipsScreen projectId={PROJECT_ID} />);

    expect(await screen.findByText(/No cron fire has been skipped/)).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("loads the next keyset page through the same endpoint when Show more is clicked", async () => {
    const user = userEvent.setup();
    const fetchImpl = mockFetchPages([
      [skip("skip_2"), skip("skip_1")],
      [skip("skip_0", { refSha: "cafebabe12345678" })],
    ]);
    vi.stubGlobal("fetch", fetchImpl);

    render(<CronSkipsScreen projectId={PROJECT_ID} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Show more" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Show more" }));

    expect(fetchImpl).toHaveBeenLastCalledWith(
      `/projects/${PROJECT_ID}/automation/cron-skips?cursor=skip_1`,
    );
    expect(await screen.findByText(/cafebab/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("surfaces a fetch error through the screen", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 })));

    render(<CronSkipsScreen projectId={PROJECT_ID} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/Could not load cron skips/);
    vi.unstubAllGlobals();
  });
});
