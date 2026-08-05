/**
 * The visual Pipeline editor (issue #20): compose a Pipeline visually, see
 * the exact YAML a PR would carry, and open that PR in the host repository.
 *
 * Direction is always visual → code, never the other way: the YAML preview
 * is read-only, there is no YAML textarea, and there is deliberately no
 * draft mode — nothing is ever stored; the repository stays the source of
 * truth and the PR is the only output. The host-repo scope is locked to the
 * Project's repositories, and the only write action is "Open PR".
 *
 * Validation runs the same shared Zod schema the control plane uses
 * (`pipelineSchema` via `@factory/shared`) on every change — immediate
 * feedback; the binding gate stays at trigger time.
 */
import { useEffect, useMemo, useState } from "react";
import { generateId, pipelineSchema, serializePipeline } from "@factory/shared";
import {
  fetchProjects,
  fetchRepositories,
  openEditorPullRequest,
  type EditorPullRequest,
  type EditorRepository,
  type ProjectRecord,
} from "./api";
import "./PipelineEditor.css";

export const DEFAULT_PIPELINE_PATH = ".factory/pipeline.yaml";

export type StepMode = "prompt" | "run";

export interface StepDraft {
  /** Stable client id for React keys — not the definition's step key. */
  uid: string;
  key: string;
  after: string[];
  mode: StepMode;
  prompt: string;
  run: string;
}

export interface PipelineEditorProps {
  /** The Project to edit in, or null at the project-less entry point — the screen then offers a picker. */
  projectId: string | null;
}

interface BuildResult {
  yaml: string | null;
  issues: { path: string; message: string }[];
}

function nextUid(): string {
  return generateId("edit");
}

function blankStep(): StepDraft {
  return { uid: nextUid(), key: "", after: [], mode: "run", prompt: "", run: "" };
}

/** Builds the Pipeline-shaped model, validates it with the shared schema, and — when valid — serializes it to the exact YAML a PR would carry. */
function buildPipeline(name: string, repo: string, steps: StepDraft[]): BuildResult {
  const model: {
    version: 1;
    name: string;
    repo: string;
    steps: Record<string, Record<string, unknown>>;
  } = {
    version: 1,
    name,
    repo,
    steps: {},
  };
  const stepKeys = new Set<string>();
  for (const draft of steps) {
    if (draft.key.trim() === "") continue;
    const key = draft.key.trim();
    if (stepKeys.has(key)) continue; // duplicates are flagged below
    stepKeys.add(key);
    const step: Record<string, unknown> = {};
    const after = draft.after.filter((dep) => stepKeys.has(dep) && dep !== key);
    if (after.length > 0) step.after = after;
    if (draft.mode === "prompt") {
      step.prompt = draft.prompt;
    } else {
      step.run = draft.run;
    }
    model.steps[key] = step;
  }

  const parsed = pipelineSchema.safeParse(model);
  if (!parsed.success) {
    return {
      yaml: null,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    };
  }
  return { yaml: serializePipeline(parsed.data), issues: [] };
}

function issuePathLabel(path: string): string {
  return path === "" ? "(root)" : path;
}

export function PipelineEditor({ projectId }: PipelineEditorProps): React.JSX.Element {
  const [allProjects, setAllProjects] = useState<ProjectRecord[] | null>(null);
  const [project, setProject] = useState<ProjectRecord | null>(null);
  const [repositories, setRepositories] = useState<EditorRepository[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState("Lint");
  const [hostRepoId, setHostRepoId] = useState("");
  const [pipelinePath, setPipelinePath] = useState(DEFAULT_PIPELINE_PATH);
  const [steps, setSteps] = useState<StepDraft[]>([
    { uid: nextUid(), key: "lint", after: [], mode: "run", prompt: "", run: "pnpm lint" },
  ]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<EditorPullRequest | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const projectsList = await fetchProjects();
        if (cancelled) return;
        setAllProjects(projectsList);
        if (projectId === null) return;
        setProject(projectsList.find((p) => p.id === projectId) ?? null);
        const repos = await fetchRepositories(projectId);
        if (cancelled) return;
        setRepositories(repos);
        if (repos.length > 0) {
          setHostRepoId(repos[0]!.id);
        }
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : "failed to load");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const hostRepo = repositories.find((repo) => repo.id === hostRepoId) ?? null;

  const { yaml, issues } = useMemo(
    () => buildPipeline(name, hostRepo?.name ?? "", steps),
    [name, hostRepo, steps],
  );

  const keyCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const draft of steps) {
      const key = draft.key.trim();
      if (key === "") continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [steps]);

  const setStep = (uid: string, patch: Partial<StepDraft>): void => {
    setSteps((current) => current.map((draft) => (draft.uid === uid ? { ...draft, ...patch } : draft)));
  };

  const addStep = (): void => {
    setSteps((current) => [...current, blankStep()]);
  };

  const removeStep = (uid: string): void => {
    setSteps((current) => current.filter((draft) => draft.uid !== uid));
  };

  const canSubmit = yaml !== null && issues.length === 0 && hostRepo !== null && !submitting;

  const submit = async (): Promise<void> => {
    if (yaml === null || hostRepo === null || projectId === null) return;
    setSubmitting(true);
    setSubmitError(null);
    setResult(null);
    try {
      const pr = await openEditorPullRequest(projectId, {
        repositoryId: hostRepo.id,
        pipelinePath: pipelinePath.trim() || DEFAULT_PIPELINE_PATH,
        yaml,
        editId: generateId("edit"),
      });
      setResult(pr);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "failed to open the PR");
    } finally {
      setSubmitting(false);
    }
  };

  if (projectId === null) {
    return (
      <main className="pipeline-editor" data-testid="pipeline-editor">
        <header className="pipeline-editor__topbar">
          <div className="pipeline-editor__brand">
            <span aria-hidden="true" className="pipeline-editor__brand-mark" />
            factory
          </div>
          <div className="pipeline-editor__crumbs">
            <strong>Pipeline editor</strong>
          </div>
        </header>
        <section className="pipeline-editor__heading">
          <div>
            <h1>Pipeline editor</h1>
            <p>Pick the Project whose host repository this Pipeline will live in.</p>
          </div>
        </section>
        {loadError !== null ? (
          <section className="pipeline-editor__error" role="alert">
            Failed to load: {loadError}
          </section>
        ) : null}
        <ul className="pipeline-editor__project-list" data-testid="project-picker" aria-label="Projects">
          {allProjects === null
            ? null
            : allProjects.map((p) => (
                <li key={p.id}>
                  <a href={`/projects/${encodeURIComponent(p.id)}/pipeline-editor`}>{p.name}</a>
                </li>
              ))}
        </ul>
      </main>
    );
  }

  return (
    <main className="pipeline-editor" data-testid="pipeline-editor">
      <header className="pipeline-editor__topbar">
        <div className="pipeline-editor__brand">
          <span aria-hidden="true" className="pipeline-editor__brand-mark" />
          factory
        </div>
        <div className="pipeline-editor__crumbs">
          <span>{project?.name ?? projectId}</span>
          <span aria-hidden="true">/</span>
          <strong>Pipeline editor</strong>
        </div>
      </header>

      <section className="pipeline-editor__heading">
        <div>
          <h1>Pipeline editor</h1>
          <p>
            Compose the Pipeline visually — the PR carries the YAML into the host repository. No draft is
            ever stored; the repository stays the source of truth.
          </p>
        </div>
        <div className="pipeline-editor__facts" aria-label="host repository">
          <label className="pipeline-editor__field">
            <span>Host repository</span>
            <select
              value={hostRepoId}
              onChange={(event) => setHostRepoId(event.target.value)}
              disabled={repositories.length === 0}
            >
              {repositories.length === 0 ? <option value="">No repositories</option> : null}
              {repositories.map((repo) => (
                <option key={repo.id} value={repo.id}>
                  {repo.owner}/{repo.name}
                </option>
              ))}
            </select>
          </label>
          <label className="pipeline-editor__field">
            <span>File</span>
            <input
              type="text"
              aria-label="pipeline file path"
              value={pipelinePath}
              onChange={(event) => setPipelinePath(event.target.value)}
            />
          </label>
        </div>
      </section>

      {loadError !== null ? (
        <section className="pipeline-editor__error" role="alert">
          Failed to load: {loadError}
        </section>
      ) : null}

      <div className="pipeline-editor__layout">
        <section className="pipeline-editor__pane pipeline-editor__steps" aria-label="Steps">
          <div className="pipeline-editor__pane-header">
            <span className="pipeline-editor__pane-title">Steps</span>
            <button type="button" className="button" onClick={addStep}>
              Add step
            </button>
          </div>
          <div className="pipeline-editor__scroll">
            <label className="pipeline-editor__field pipeline-editor__name-field">
              <span>Pipeline name</span>
              <input
                type="text"
                aria-label="pipeline name"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            {steps.map((draft, index) => {
              const duplicate = keyCounts.get(draft.key.trim()) !== undefined && keyCounts.get(draft.key.trim())! > 1;
              return (
                <article className="pipeline-editor__step" key={draft.uid} data-testid={`step-${draft.uid}`}>
                  <div className="pipeline-editor__step-head">
                    <label className="pipeline-editor__field pipeline-editor__key-field">
                      <span>Key</span>
                      <input
                        type="text"
                        aria-label={`step ${index + 1} key`}
                        value={draft.key}
                        onChange={(event) => setStep(draft.uid, { key: event.target.value })}
                      />
                    </label>
                    {duplicate ? <span className="pipeline-editor__step-warn">duplicate key</span> : null}
                    <button type="button" className="button button--quiet" onClick={() => removeStep(draft.uid)}>
                      Remove
                    </button>
                  </div>
                  <fieldset className="pipeline-editor__mode">
                    <legend>Mode</legend>
                    <label>
                      <input
                        type="radio"
                        name={`mode-${draft.uid}`}
                        checked={draft.mode === "prompt"}
                        onChange={() => setStep(draft.uid, { mode: "prompt" })}
                      />
                      Agent prompt
                    </label>
                    <label>
                      <input
                        type="radio"
                        name={`mode-${draft.uid}`}
                        checked={draft.mode === "run"}
                        onChange={() => setStep(draft.uid, { mode: "run" })}
                      />
                      Shell run
                    </label>
                  </fieldset>
                  {draft.mode === "prompt" ? (
                    <textarea
                      className="pipeline-editor__prompt"
                      aria-label={`step ${index + 1} prompt`}
                      placeholder="What the agent should do"
                      value={draft.prompt}
                      onChange={(event) => setStep(draft.uid, { prompt: event.target.value })}
                    />
                  ) : (
                    <input
                      type="text"
                      className="pipeline-editor__run"
                      aria-label={`step ${index + 1} run`}
                      placeholder="pnpm build"
                      value={draft.run}
                      onChange={(event) => setStep(draft.uid, { run: event.target.value })}
                    />
                  )}
                  <fieldset className="pipeline-editor__after">
                    <legend>Runs after</legend>
                    {steps.filter((other) => other.uid !== draft.uid && other.key.trim() !== "").length === 0 ? (
                      <span className="pipeline-editor__after-empty">No other named steps yet.</span>
                    ) : null}
                    {steps
                      .filter((other) => other.uid !== draft.uid && other.key.trim() !== "")
                      .map((other) => (
                        <label key={other.uid}>
                          <input
                            type="checkbox"
                            checked={draft.after.includes(other.key.trim())}
                            onChange={(event) => {
                              const key = other.key.trim();
                              setStep(draft.uid, {
                                after: event.target.checked
                                  ? [...draft.after, key]
                                  : draft.after.filter((dep) => dep !== key),
                              });
                            }}
                          />
                          {other.key.trim()}
                        </label>
                      ))}
                  </fieldset>
                </article>
              );
            })}
          </div>
        </section>

        <section className="pipeline-editor__pane pipeline-editor__definition" aria-label="Definition and PR">
          <div className="pipeline-editor__pane-header">
            <span className="pipeline-editor__pane-title">Definition</span>
            {yaml !== null ? (
              <span className="pipeline-editor__valid-badge">Valid</span>
            ) : (
              <span className="pipeline-editor__invalid-badge">{issues.length} issues</span>
            )}
          </div>
          <div className="pipeline-editor__scroll">
            {issues.length > 0 ? (
              <ul className="pipeline-editor__issues" role="list" aria-label="validation issues">
                {issues.map((issue, idx) => (
                  <li key={idx}>
                    <code>{issuePathLabel(issue.path)}</code> {issue.message}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="pipeline-editor__valid-note">
                Valid per the shared Pipeline schema — the control plane re-validates at trigger time.
              </p>
            )}
            <pre className="pipeline-editor__yaml" data-testid="yaml-preview">
              {yaml ?? "The definition is not valid yet — fix the issues above to see the YAML."}
            </pre>
            <div className="pipeline-editor__actions">
              <button
                type="button"
                className="button button--primary"
                disabled={!canSubmit}
                onClick={() => void submit()}
              >
                {submitting ? "Opening PR..." : "Open PR"}
              </button>
              <span className="pipeline-editor__scope-note">
                PR opens in {hostRepo ? `${hostRepo.owner}/${hostRepo.name}` : "the host repository"} · attributed
                to you, committed by factory[bot]
              </span>
            </div>
            {submitError !== null ? (
              <p className="pipeline-editor__error" role="alert">
                {submitError}
              </p>
            ) : null}
            {result !== null ? (
              <div className="pipeline-editor__result" data-testid="editor-pr-result">
                <strong>PR opened</strong>
                <a href={result.prUrl} target="_blank" rel="noreferrer">
                  {result.prUrl}
                </a>
                <span>
                  <code>{result.headBranch}</code> · <code>{result.commitSha}</code>
                </span>
              </div>
            ) : null}
          </div>
        </section>
      </div>
    </main>
  );
}
