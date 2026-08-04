/**
 * Trigger a Pipeline over a ref, and materialize the initial Graph.
 * spec.md "Definisi Pipeline" + "Semantik eksekusi"; CONTEXT.md "Pipeline",
 * "Run", "Graph".
 *
 * Pipeline identity is host Repository + file path — there is no
 * `pipelines` table (spec: "Definisi Pipeline"). The definition is always
 * read from the ref being triggered, through `GitHost`, never from a
 * default branch and never from a cache (that cache is Automation's, issue
 * #18 — a manual trigger reads live every time).
 *
 * Materialization scope, deliberately narrower than the full "hybrid"
 * picture ticket 06-dag-execution-semantics.md describes: this issue
 * inserts a StepRun, outcome `ready`, for exactly the Steps whose `after:`
 * is empty and which are not themselves a fan-out source (`branches:` /
 * `branchesFrom:`). Every other Step — anything with an unmet dependency,
 * fan-out or not — is intentionally left unmaterialized. Two facts about
 * this codebase force that boundary, not a reading of convenience:
 *
 *  1. `step_runs.outcome`'s CHECK constraint is closed over exactly
 *     `ready | running | awaiting-human | succeeded | failed | skipped |
 *     cancelled` — there is no "materialized but blocked on an upstream
 *     Step" value. Giving a Step with unmet dependencies `outcome: 'ready'`
 *     would make it claimable immediately: `claim_step_run.sql` (already
 *     shipped, already has seven green contract tests) filters purely on
 *     `outcome = 'ready'`, with no join back to its dependencies.
 *  2. Nothing in this issue's scope can ever move a StepRun to a terminal
 *     state — that is issue #5's `/result` endpoint. The event-driven
 *     "evaluate downstream when an upstream Step finishes" mechanism the
 *     06-dag ticket describes has no caller yet within this issue, and
 *     code with no caller is exactly what YAGNI asks us not to write.
 *
 * See the written report for this as an open question for review.
 */
import { and, desc, eq, isNull, lt } from "drizzle-orm";
import {
  generateId,
  validatePipelineDefinition,
  type Id,
  type Pipeline,
  type ValidationIssue,
} from "@factory/shared";
import { repositories, runs, stepRuns } from "../db/schema.js";
import type { AppDeps } from "../deps.js";
import type { Principal } from "./principal.js";
import { requireProjectMembership } from "./projects.js";
import { recordAuditEvent } from "./audit.js";
import { DomainValidationError, NotFoundError } from "./errors.js";
import { RefNotFoundError, type RepoRef } from "./git-host.js";

export type Run = typeof runs.$inferSelect;
export type StepRun = typeof stepRuns.$inferSelect;

/**
 * Combined cap on (definition YAML text + every prompt file it references),
 * enforced before a Run row is ever written (spec: "batas ukuran
 * ditegakkan saat validasi"). Not a number spec.md states explicitly — see
 * the written report.
 */
export const MAX_TOTAL_DEFINITION_BYTES = 2 * 1024 * 1024;

export interface TriggerRunInput {
  /** Client-generated (spec: "Id Run dibangkitkan klien") — a double-triggered id is rejected by the `runs` primary key, not by an application-level guard. */
  id: Id<"run">;
  repositoryId: Id<"repository">;
  pipelinePath: string;
  refBranch: string;
}

export interface TriggeredRun {
  run: Run;
  stepRuns: StepRun[];
}

/** A Step is materializable up front iff it has no unmet dependency and is not itself a fan-out source — see the file-level doc for why this is narrower than "every non-fan-out Step". */
function materializableRootStepIds(pipeline: Pipeline): string[] {
  return Object.entries(pipeline.steps)
    .filter(([, step]) => step.after.length === 0 && step.branches === undefined && step.branchesFrom === undefined)
    .map(([id]) => id);
}

/**
 * Every distinct `promptFile:` the Pipeline references — top-level Steps and
 * each Branch's *effective* one (its own, or inherited from the parent
 * Step). Collected across the whole Pipeline, not just the materializable
 * subset: the Run's copy of prompt file contents must survive the
 * definition changing or disappearing later, including for Steps that
 * haven't materialized yet (spec: Run "menyimpan salinan penuh ...
 * sehingga tetap terbaca meskipun definisi aslinya berubah atau hilang").
 */
function collectPromptFilePaths(pipeline: Pipeline): string[] {
  const paths = new Set<string>();
  for (const step of Object.values(pipeline.steps)) {
    if (step.promptFile) paths.add(step.promptFile);
    if (step.branches) {
      for (const branch of step.branches) {
        const effective = branch.promptFile ?? step.promptFile;
        if (effective) paths.add(effective);
      }
    }
  }
  return [...paths];
}

/** Every issue already carries a line/column via `validatePipelineDefinition` — this just flattens them into the one-string `message` the error envelope has room for (spec: "pesan yang menunjuk baris"). */
function formatValidationIssues(issues: ValidationIssue[]): string {
  return issues
    .map((issue) => {
      const location = issue.line !== null ? `line ${issue.line}` : issue.path.join(".") || "(root)";
      return `${location}: ${issue.message}`;
    })
    .join("; ");
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "23505"
  );
}

async function findRepositoryByName(
  deps: Pick<AppDeps, "db">,
  projectId: Id<"project">,
  name: string,
): Promise<typeof repositories.$inferSelect | undefined> {
  const [repo] = await deps.db
    .select()
    .from(repositories)
    .where(and(eq(repositories.projectId, projectId), eq(repositories.name, name)));
  return repo;
}

/**
 * Triggers a Pipeline over `input.refBranch`: reads the definition and every
 * prompt file it references from that ref (never the default branch),
 * validates, and — if valid — materializes the Run and its initial Graph in
 * one Postgres transaction. Rejects before any row exists on: a missing
 * ref, a missing definition file, a definition that fails
 * `validatePipelineDefinition`, a combined size over
 * {@link MAX_TOTAL_DEFINITION_BYTES}, or a Step `repo:` that doesn't name a
 * Repository of this Project.
 */
export async function triggerRun(
  deps: Pick<AppDeps, "db" | "clock" | "gitHost">,
  principal: Principal,
  projectId: Id<"project">,
  input: TriggerRunInput,
): Promise<TriggeredRun> {
  await requireProjectMembership(deps, principal, projectId);

  const [pipelineRepository] = await deps.db
    .select()
    .from(repositories)
    .where(and(eq(repositories.id, input.repositoryId), eq(repositories.projectId, projectId)));
  if (!pipelineRepository) {
    throw new NotFoundError("repository", input.repositoryId);
  }
  const repoRef: RepoRef = { owner: pipelineRepository.owner, name: pipelineRepository.name };

  let sha: string;
  try {
    sha = await deps.gitHost.resolveRef(repoRef, input.refBranch);
  } catch (error) {
    if (error instanceof RefNotFoundError) {
      throw new DomainValidationError("ref_not_found", error.message);
    }
    throw error;
  }

  const definitionText = await deps.gitHost.readFile(repoRef, sha, input.pipelinePath);
  if (definitionText === null) {
    throw new DomainValidationError(
      "pipeline_definition_not_found",
      `no file at ${input.pipelinePath} on ref ${input.refBranch} (${sha}) in ${pipelineRepository.owner}/${pipelineRepository.name}`,
    );
  }

  const validation = validatePipelineDefinition(definitionText);
  if (!validation.valid) {
    throw new DomainValidationError("pipeline_definition_invalid", formatValidationIssues(validation.issues));
  }
  const { pipeline } = validation;

  const promptFilePaths = collectPromptFilePaths(pipeline);
  const definitionFiles: Record<string, string> = {};
  let totalBytes = Buffer.byteLength(definitionText, "utf-8");
  for (const path of promptFilePaths) {
    const content = await deps.gitHost.readFile(repoRef, sha, path);
    if (content === null) {
      throw new DomainValidationError(
        "prompt_file_not_found",
        `promptFile '${path}' referenced by the Pipeline does not exist on ref ${input.refBranch} (${sha}) in ${pipelineRepository.owner}/${pipelineRepository.name}`,
      );
    }
    definitionFiles[path] = content;
    totalBytes += Buffer.byteLength(content, "utf-8");
  }

  if (totalBytes > MAX_TOTAL_DEFINITION_BYTES) {
    throw new DomainValidationError(
      "pipeline_definition_too_large",
      `definition (${Buffer.byteLength(definitionText, "utf-8")} bytes) plus ${promptFilePaths.length} prompt file(s) total ${totalBytes} bytes, over the ${MAX_TOTAL_DEFINITION_BYTES}-byte inline storage limit`,
    );
  }

  // Resolve every materializable Step's repo: before opening the
  // transaction — an unknown repo name is a validation error, and a
  // validation error must not leave a partial Run behind.
  const rootStepIds = materializableRootStepIds(pipeline);
  const stepRepositoryByStepId = new Map<string, typeof repositories.$inferSelect>();
  for (const stepId of rootStepIds) {
    const step = pipeline.steps[stepId]!;
    const repoName = step.repo ?? pipeline.repo;
    const stepRepo = await findRepositoryByName(deps, projectId, repoName);
    if (!stepRepo) {
      throw new DomainValidationError(
        "step_repository_not_found",
        `Step '${stepId}' references repo '${repoName}', which is not a Repository of this Project`,
      );
    }
    stepRepositoryByStepId.set(stepId, stepRepo);
  }

  const readyAt = deps.clock.now();

  let result: TriggeredRun;
  try {
    result = await deps.db.transaction(async (tx) => {
      const [insertedRun] = await tx
        .insert(runs)
        .values({
          id: input.id,
          projectId,
          pipelineRepositoryId: pipelineRepository.id,
          pipelinePath: input.pipelinePath,
          triggerKind: "manual",
          triggeredByPrincipalId: principal.id,
          credentialPrincipalId: principal.id,
          refBranch: input.refBranch,
          refSha: sha,
          definition: definitionText,
          definitionFiles,
        })
        .returning();

      const createdStepRuns: StepRun[] = [];
      for (const stepId of rootStepIds) {
        const step = pipeline.steps[stepId]!;
        const stepRepo = stepRepositoryByStepId.get(stepId)!;
        const [stepRun] = await tx
          .insert(stepRuns)
          .values({
            id: generateId("steprun"),
            runId: insertedRun!.id,
            repositoryId: stepRepo.id,
            stepKey: stepId,
            branchKey: null,
            turn: 1,
            attempt: 1,
            outcome: "ready",
            kind: step.kind ?? null,
            requiredTags: step.runsOn ?? [],
            readyAt,
          })
          .returning();
        createdStepRuns.push(stepRun!);
      }

      return { run: insertedRun!, stepRuns: createdStepRuns };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new DomainValidationError("run_id_conflict", `a Run with id ${input.id} already exists`);
    }
    throw error;
  }

  await recordAuditEvent(deps, {
    actor: principal,
    projectId,
    action: "run.triggered",
    targetType: "run",
    targetId: result.run.id,
    metadata: { pipelinePath: input.pipelinePath, refBranch: input.refBranch, refSha: sha },
  });

  return result;
}

export interface RunListFilters {
  /** `ended_at IS NULL` — distinct from `outcome`, never combined with it (spec: "filter ... terpisah tegas"). */
  inFlight?: boolean;
  /** `outcome = ...` — a Run's final verdict. */
  outcome?: "succeeded" | "failed" | "cancelled";
}

export interface RunPage {
  runs: Run[];
  /** Null when this page was not full — there is no total count (spec: "tanpa total count"). */
  nextCursor: Id<"run"> | null;
}

/** Keyset pagination on `id` DESC (newest first) — never offset (spec: "daftar yang di-poll 3 detik bergeser di bawah pembaca"). */
export async function listRuns(
  deps: Pick<AppDeps, "db">,
  principal: Principal,
  projectId: Id<"project">,
  filters: RunListFilters,
  cursor: Id<"run"> | null,
  limit: number,
): Promise<RunPage> {
  await requireProjectMembership(deps, principal, projectId);

  const conditions = [eq(runs.projectId, projectId)];
  if (filters.inFlight) {
    conditions.push(isNull(runs.endedAt));
  }
  if (filters.outcome) {
    conditions.push(eq(runs.outcome, filters.outcome));
  }
  if (cursor) {
    conditions.push(lt(runs.id, cursor));
  }

  const rows = await deps.db
    .select()
    .from(runs)
    .where(and(...conditions))
    .orderBy(desc(runs.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? (page[page.length - 1]!.id as Id<"run">) : null;

  return { runs: page, nextCursor };
}

export interface RunWithGraph {
  run: Run;
  stepRuns: StepRun[];
}

/** One Run plus its materialized Graph so far — the placeholder for anything not yet materialized is a UI concern, not a row (spec: 06-dag "simpul placeholder"). */
export async function getRun(
  deps: Pick<AppDeps, "db">,
  principal: Principal,
  projectId: Id<"project">,
  runId: Id<"run">,
): Promise<RunWithGraph> {
  await requireProjectMembership(deps, principal, projectId);

  const [run] = await deps.db.select().from(runs).where(and(eq(runs.id, runId), eq(runs.projectId, projectId)));
  if (!run) {
    throw new NotFoundError("run", runId);
  }

  const graph = await deps.db.select().from(stepRuns).where(eq(stepRuns.runId, runId));
  return { run, stepRuns: graph };
}
