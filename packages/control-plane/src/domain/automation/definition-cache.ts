/**
 * How Pipeline definitions are acquired: read fresh from a ref and
 * validated (`readAndValidateAt`), plus the `pipeline_definition_cache`
 * fill (`fillCacheFromPush`). The cache is mandatory for discovery — there
 * is no other path from "which (Repository, path) pairs are Pipelines" —
 * but disposable: the next push rebuilds it.
 */
import { and, eq } from "drizzle-orm";
import { validatePipelineDefinition, type Pipeline } from "@factory/shared";
import { pipelineDefinitionCache, repositories } from "../../db/schema.js";
import type { GitHost, RepoRef } from "../git-host.js";
import type { AutomationDeps } from "./deps.js";

/** A pipeline definition read fresh from a ref and validated. */
export interface ReadDefinition {
  text: string;
  pipeline: Pipeline;
}

/** Reads and validates a definition file at an exact sha. `null` = missing or invalid — both mean "not a triggerable Pipeline". */
export async function readAndValidateAt(
  gitHost: GitHost,
  repo: RepoRef,
  sha: string,
  path: string,
): Promise<ReadDefinition | null> {
  const text = await gitHost.readFile(repo, sha, path);
  if (text === null) return null;
  const validation = validatePipelineDefinition(text);
  if (!validation.valid) return null;
  return { text, pipeline: validation.pipeline };
}

/**
 * Fill-on-miss, synchronously: every path a push touched is read at the
 * pushed sha and upserted into `pipeline_definition_cache` when it validates
 * as a Pipeline. Removed paths drop their cache row — a deleted Pipeline
 * must stop discovering itself. This is the only refill the cache has, and
 * it is exactly what makes the "cache boleh dihapus kapan saja" claim honest:
 * the next event rebuilds it.
 */
export async function fillCacheFromPush(
  deps: AutomationDeps,
  repository: typeof repositories.$inferSelect,
  repoRef: RepoRef,
  branch: string,
  sha: string,
  changedPaths: string[],
  removedPaths: string[],
): Promise<void> {
  const now = deps.clock.now();
  for (const path of changedPaths) {
    if (removedPaths.includes(path)) {
      await deps.db
        .delete(pipelineDefinitionCache)
        .where(and(eq(pipelineDefinitionCache.repositoryId, repository.id), eq(pipelineDefinitionCache.path, path)));
      continue;
    }
    const definition = await readAndValidateAt(deps.gitHost, repoRef, sha, path);
    if (definition === null) continue; // not a Pipeline — the cache indexes Pipelines only.
    await deps.db
      .insert(pipelineDefinitionCache)
      .values({
        repositoryId: repository.id,
        path,
        ref: branch,
        contentSha: sha,
        parsed: definition.pipeline,
        fetchedAt: now,
      })
      .onConflictDoUpdate({
        target: [pipelineDefinitionCache.repositoryId, pipelineDefinitionCache.path],
        set: { ref: branch, contentSha: sha, parsed: definition.pipeline, fetchedAt: now },
      });
  }
}
