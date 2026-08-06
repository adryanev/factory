/**
 * The web <-> control-plane client for the visual Pipeline editor (issue
 * #20). Two reads and one write — exactly the surface the editor needs, and
 * nothing that could ever grow into a draft mode: the repository stays the
 * source of truth, the only write opens a PR.
 */
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from "../questions/api";

export interface ProjectRecord {
  id: string;
  name: string;
}

export interface EditorRepository {
  id: string;
  owner: string;
  name: string;
  defaultBranch: string;
}

export interface EditorPullRequest {
  prNumber: number;
  prUrl: string;
  headBranch: string;
  commitSha: string;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const response = await fetch(url, init);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : undefined) as T };
}

/** The Projects the caller is a member of — the editor's scope starts here. */
export async function fetchProjects(): Promise<ProjectRecord[]> {
  const { body } = await fetchJson<ProjectRecord[]>("/projects");
  return body;
}

/** The host-repo candidates the editor may lock onto: this Project's repositories, nothing else (AC1). */
export async function fetchRepositories(projectId: string): Promise<EditorRepository[]> {
  const { body } = await fetchJson<{ repositories: EditorRepository[] }>(
    `/projects/${encodeURIComponent(projectId)}/repositories`,
  );
  return body.repositories;
}

/** Opens the editor's PR. `editId` is a client-generated idempotency key that rides in the branch name. */
export async function openEditorPullRequest(
  projectId: string,
  input: { repositoryId: string; pipelinePath: string; yaml: string; editId: string },
): Promise<EditorPullRequest> {
  const { status, body } = await fetchJson<EditorPullRequest>(`/projects/${encodeURIComponent(projectId)}/pipeline-editor`, {
    method: "POST",
    headers: { "content-type": "application/json", [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
    body: JSON.stringify(input),
  });
  if (status !== 201) {
    const message = (body as { message?: string } | undefined)?.message ?? `editor PR failed: HTTP ${status}`;
    throw new Error(message);
  }
  return body;
}
