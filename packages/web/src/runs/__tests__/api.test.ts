import { afterEach, describe, expect, it, vi } from "vitest";
import { cancelRun, fetchRun } from "../api";
import type { RunDetail } from "../api";

const run: RunDetail = {
  run: {
    id: "run_01etag",
    projectId: "project_01etag",
    pipelineRepositoryId: "repository_pipeline",
    pipelinePath: ".factory/pipeline.yaml",
    triggerKind: "manual",
    triggeredByPrincipalId: "user_01etag",
    credentialPrincipalId: "user_01etag",
    refBranch: "main",
    refSha: "abc",
    parentRunId: null,
    cancelRequestedAt: null,
    outcome: null,
    endedAt: null,
    definition: "version: 1",
    definitionFiles: {},
  },
  stepRuns: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("run API client", () => {
  it("sends ETag on the next poll and accepts a body-less 304", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(run), { status: 200, headers: { etag: '"v1"' } }))
      .mockResolvedValueOnce(new Response(null, { status: 304, headers: { etag: '"v1"' } }));
    vi.stubGlobal("fetch", fetchMock);

    const first = await fetchRun("project_01etag", "run_01etag");
    const second = await fetchRun("project_01etag", "run_01etag", first.etag ?? undefined);

    expect(first).toEqual({ status: "ok", data: run, etag: '"v1"' });
    expect(second).toEqual({ status: "not-modified", etag: '"v1"' });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ headers: { "if-none-match": '"v1"' } });
  });

  it("records Run cancellation with the CSRF header and returns intent state", async () => {
    const cancelled = { ...run.run, cancelRequestedAt: "2026-08-04T08:00:00.000Z" };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ run: cancelled }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(cancelRun("project_01etag", "run_01etag")).resolves.toEqual(cancelled);
    expect(fetchMock).toHaveBeenCalledWith(
      "/projects/project_01etag/runs/run_01etag/cancel",
      expect.objectContaining({
        method: "POST",
        headers: { "x-factory-csrf": "1" },
      }),
    );
  });
});
