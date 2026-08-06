/**
 * Cron/schedule triggers — the reason this module changes when scheduling
 * semantics change. The minute-gated schedule sweep, plus the visible
 * "cron yang dilewati" surface. Reads definitions fresh from the default
 * branch; the definition cache is only the discovery index.
 */
import { and, desc, eq, isNull, lt } from "drizzle-orm";
import { cronMatches, generateId, type Id } from "@factory/shared";
import { cronSkips, pipelineDefinitionCache, projects, repositories, runs } from "../../db/schema.js";
import type { AppDeps } from "../../deps.js";
import type { AutomationSweepDeps } from "./deps.js";
import type { Principal } from "../principal.js";
import type { RepoRef } from "../git-host.js";
import { requireProjectMembership } from "../projects.js";
import { readAndValidateAt } from "./definition-cache.js";
import { triggerAutomationRun } from "./trigger.js";

/** The schedule sweep, gated to one evaluation per UTC minute per instance (a second evaluation in the same minute would re-read every scheduled definition for nothing — layer-2 dedup already makes it harmless, the watermark just keeps it cheap). */
const SCHEDULE_MINUTE_LENGTH = 16; // "2026-01-01T03:00" — toISOString() up to the minute.

export async function sweepSchedules(deps: AutomationSweepDeps): Promise<void> {
  const now = deps.clock.now();
  const minute = now.toISOString().slice(0, SCHEDULE_MINUTE_LENGTH);
  if (deps.scheduleWatermark.minute === minute) return;
  deps.scheduleWatermark.minute = minute;

  const rows = await deps.db
    .select({ project: projects, repository: repositories, cache: pipelineDefinitionCache })
    .from(pipelineDefinitionCache)
    .innerJoin(repositories, eq(repositories.id, pipelineDefinitionCache.repositoryId))
    .innerJoin(projects, eq(projects.id, repositories.projectId))
    .where(eq(projects.automationEnabled, true));

  for (const { project, repository, cache } of rows) {
    const repoRef: RepoRef = { owner: repository.owner, name: repository.name };
    let defaultSha: string;
    try {
      defaultSha = await deps.gitHost.resolveRef(repoRef, repository.defaultBranch);
    } catch {
      continue; // the default branch is gone — nothing to schedule from.
    }
    // The definition is read from the default branch — a schedule merged to
    // the default branch lives only after the merge (a PR cannot schedule).
    const definition = await readAndValidateAt(deps.gitHost, repoRef, defaultSha, cache.path);
    if (definition === null) continue;
    const schedule = definition.pipeline.on?.schedule;
    if (!schedule || !schedule.some((expression) => cronMatches(expression, now))) continue;

    const [active] = await deps.db
      .select({ refSha: runs.refSha })
      .from(runs)
      .where(
        and(
          eq(runs.projectId, project.id),
          eq(runs.triggerKind, "automation"),
          eq(runs.pipelineRepositoryId, repository.id),
          eq(runs.pipelinePath, cache.path),
          eq(runs.refBranch, repository.defaultBranch),
          isNull(runs.endedAt),
        ),
      )
      .limit(1);
    if (active) {
      // Same-SHA overlap is layer-2 dedup (silent — this minute's Run already
      // exists, possibly born by the other control-plane instance racing us).
      // A different-SHA active Run is a genuine overlap: skipped, visibly.
      if (active.refSha !== defaultSha) {
        await deps.db.insert(cronSkips).values({
          id: generateId("skip"),
          projectId: project.id,
          pipelineRepositoryId: repository.id,
          pipelinePath: cache.path,
          refBranch: repository.defaultBranch,
          refSha: defaultSha,
          scheduledFor: now,
          skippedAt: now,
          reason: "run-active",
        });
      }
      continue;
    }
    await triggerAutomationRun(deps, project, repository, cache.path, definition, repository.defaultBranch, defaultSha);
  }
}

export interface CronSkipPage {
  skips: (typeof cronSkips.$inferSelect)[];
  nextCursor: string | null;
}

/** The "cron yang dilewati" surface — keyset on id DESC, newest first, same shape as the Run list. */
export async function listCronSkips(
  deps: Pick<AppDeps, "db">,
  principal: Principal,
  projectId: Id<"project">,
  cursor: string | null,
  limit: number,
): Promise<CronSkipPage> {
  await requireProjectMembership(deps, principal, projectId);
  const conditions = [eq(cronSkips.projectId, projectId)];
  if (cursor) conditions.push(lt(cronSkips.id, cursor as Id<"skip">));
  const rows = await deps.db
    .select()
    .from(cronSkips)
    .where(and(...conditions))
    .orderBy(desc(cronSkips.id))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return { skips: page, nextCursor: hasMore ? (page[page.length - 1]!.id) : null };
}
