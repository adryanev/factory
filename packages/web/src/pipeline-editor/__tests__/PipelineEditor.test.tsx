import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PipelineEditor } from "../PipelineEditor";
import { fetchProjects, fetchRepositories, openEditorPullRequest } from "../api";
import type { EditorPullRequest, EditorRepository, ProjectRecord } from "../api";

vi.mock("../api", () => ({
  fetchProjects: vi.fn(),
  fetchRepositories: vi.fn(),
  openEditorPullRequest: vi.fn(),
}));

const PROJECT_ID = "project_01editor";
const REPOSITORY_ID = "repository_backend";

function projects(): ProjectRecord[] {
  return [{ id: PROJECT_ID, name: "checkout" }];
}

function repositories(): EditorRepository[] {
  return [{ id: REPOSITORY_ID, owner: "acme", name: "backend", defaultBranch: "main" }];
}

function prResult(): EditorPullRequest {
  return {
    prNumber: 42,
    prUrl: "https://github.com/acme/backend/pull/42",
    headBranch: "factory/editor/edit_abc123",
    commitSha: "deadbeef",
  };
}

beforeEach(() => {
  vi.mocked(fetchProjects).mockResolvedValue(projects());
  vi.mocked(fetchRepositories).mockResolvedValue(repositories());
  vi.mocked(openEditorPullRequest).mockResolvedValue(prResult());
});

describe("PipelineEditor", () => {
  it("locks the UI scope to the Project's host repositories and shows a valid YAML preview with no draft controls", async () => {
    render(<PipelineEditor projectId={PROJECT_ID} />);

    // The select itself renders before the repo fetch lands — wait for the
    // loaded state, not the always-present control.
    const hostSelect = await screen.findByLabelText("Host repository");
    await screen.findByRole("option", { name: "acme/backend" });
    const options = within(hostSelect).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["acme/backend"]);

    expect(screen.getByTestId("yaml-preview")).toHaveTextContent("repo: backend");
    expect(screen.getByText("Valid")).toBeInTheDocument();
    // Visual -> code only: no YAML textarea, and no draft/save action anywhere.
    expect(screen.queryByRole("textbox", { name: /yaml|definition text/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /save|draft|simpan/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open PR" })).toBeEnabled();
  });

  it("shows the project picker when opened without a project id", async () => {
    render(<PipelineEditor projectId={null} />);
    const picker = await screen.findByTestId("project-picker");
    // The list element renders before projects load — wait for a project link.
    const link = await screen.findByRole("link", { name: "checkout" });
    expect(link).toHaveAttribute("href", `/projects/${PROJECT_ID}/pipeline-editor`);
    expect(within(picker).getByRole("link", { name: "checkout" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open PR" })).not.toBeInTheDocument();
  });

  it("gives immediate validation feedback from the shared schema while the user composes", async () => {
    const user = userEvent.setup();
    render(<PipelineEditor projectId={PROJECT_ID} />);
    await screen.findByLabelText("Host repository");
    await screen.findByRole("option", { name: "acme/backend" });

    await user.click(screen.getByRole("button", { name: "Add step" }));
    await user.type(screen.getByLabelText("step 2 key"), "test");
    await user.type(screen.getByLabelText("step 2 run"), "pnpm test");
    await user.click(screen.getByRole("checkbox", { name: "lint" }));
    expect(screen.getByTestId("yaml-preview")).toHaveTextContent("after:");
    expect(screen.getByTestId("yaml-preview")).toHaveTextContent("run: pnpm test");
    expect(screen.getByText("Valid")).toBeInTheDocument();

    // Break the definition: a step with no run command (run: is min(1)).
    await user.clear(screen.getByLabelText("step 2 run"));
    expect(screen.getByRole("list", { name: "validation issues" })).toHaveTextContent(/too small|invalid/i);
    expect(screen.getByRole("button", { name: "Open PR" })).toBeDisabled();
  });

  it("opens the PR with the serialized YAML, the host repo, and a client-generated edit id, then shows the PR link", async () => {
    const user = userEvent.setup();
    render(<PipelineEditor projectId={PROJECT_ID} />);
    await screen.findByLabelText("Host repository");
    await screen.findByRole("option", { name: "acme/backend" });

    await user.click(screen.getByRole("button", { name: "Open PR" }));

    expect(openEditorPullRequest).toHaveBeenCalledTimes(1);
    const body = vi.mocked(openEditorPullRequest).mock.calls[0]![1];
    expect(body.repositoryId).toBe(REPOSITORY_ID);
    expect(body.pipelinePath).toBe(".factory/pipeline.yaml");
    expect(body.yaml).toContain("version: 1");
    expect(body.yaml).toContain("repo: backend");
    expect(body.yaml).toContain("run: pnpm lint");
    expect(body.editId).toMatch(/^edit_[a-z0-9]+$/);

    expect(await screen.findByTestId("editor-pr-result")).toHaveTextContent(
      "https://github.com/acme/backend/pull/42",
    );
    expect(within(screen.getByTestId("editor-pr-result")).getByRole("link")).toHaveAttribute(
      "href",
      "https://github.com/acme/backend/pull/42",
    );
  });

  it("surfaces a rejected PR with the control plane's message", async () => {
    const user = userEvent.setup();
    vi.mocked(openEditorPullRequest).mockRejectedValue(new Error("github_identity_required: no GitHub identity"));
    render(<PipelineEditor projectId={PROJECT_ID} />);
    await screen.findByLabelText("Host repository");
    await screen.findByRole("option", { name: "acme/backend" });

    await user.click(screen.getByRole("button", { name: "Open PR" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("github_identity_required");
  });
});
