/**
 * The retention sweep's application half (spec: "Artifact dan blob" + issue
 * 25-database-schema.md, "Retensi: penanda `*_purged_at` dengan partial
 * index"). The SQL half lives in `db/sql/retention_sweeps.sql` — five
 * SELECT-candidates + UPDATE-marks-purged pairs, hand-written, with contract
 * tests that run them twice against a real Postgres (spec: "Tiga SQL tangan
 * ... contract test langsung ke Postgres"). This file is what sits between
 * the two statements of each pair: it reads the candidates the SELECT locked,
 * deletes the bytes/branches the marker stands for — outside any SQL
 * transaction — and only then runs the UPDATE that records the cleanup fact.
 *
 * The marker-only-after-deletion order is what makes the whole thing
 * idempotent: a run whose blob or branch deletion failed mid-way is simply
 * not marked, so the next round re-selects it and retries; a blob/branch
 * that was already deleted is deleted again harmlessly (DELETE of a missing
 * object is not an error, and `deleteRef` treats a gone ref as success).
 *
 * "Sweep adalah indexed scan yang menyusut sambil bekerja": every candidate
 * SELECT walks a partial index over `ended_at`/`received_at` where the
 * marker is NULL, so a marked row vanishes from the next round's scan.
 * `FOR UPDATE SKIP LOCKED` keeps two sweep instances from processing the
 * same batch, and the UPDATE's `IS NULL` guard makes a second writer a
 * no-op rather than a race.
 *
 * Cost retention stays forever by construction: nothing here deletes rows
 * from `runs`, `step_runs`, or `step_run_costs` — the sweep only removes
 * bytes and branches and then writes a marker on the owner row (spec:
 * "Retensi: tidak pernah kedaluwarsa, seumur baris Run").
 *
 * "Branch yatim dari giliran yang mati ikut dibersihkan" is structural, not
 * a special case: the branch sweep lists refs by the `run/<run-id>` prefix
 * in every repo the Run's StepRuns touched and deletes what it finds, so a
 * branch a dead turn pushed without ever recording it (cancel, lease lost,
 * output-invalid) is found the same way as a recorded one.
 */
import { eq } from "drizzle-orm";
import type { Id } from "@factory/shared";
import { artifacts, githubAppInstallations, logChunks, repositories, stepRuns } from "../db/schema.js";
import type { AppDeps } from "../deps.js";
import { loadSqlStatements } from "../db/sql/load.js";

const [
  artifactCandidate,
  artifactMark,
  logCandidate,
  logMark,
  branchCandidate,
  branchMark,
  sessionCandidate,
  sessionMark,
  webhookCandidate,
  webhookMark,
] = requireSweepPairs(loadSqlStatements("retention_sweeps.sql"));

/** The five SELECT/UPDATE pairs, in the order the file documents them — same guard the contract test applies, so a reshaped file fails here and in the test at the same place. */
function requireSweepPairs(statements: string[]): [string, string, string, string, string, string, string, string, string, string] {
  if (statements.length !== 10) {
    throw new Error(
      `expected 10 statements (5 SELECT/UPDATE pairs) in retention_sweeps.sql, got ${statements.length}`,
    );
  }
  return statements as [string, string, string, string, string, string, string, string, string, string];
}

/** The composition-root slice the sweeper needs. `pool` is the raw pg pool — the hand-written SQL needs positional `$1` binding that Drizzle's builder cannot express (same reason as `step-run-claim.ts`). */
export interface RetentionSweepDeps {
  db: AppDeps["db"];
  pool: AppDeps["pool"];
  objectStore: AppDeps["objectStore"];
  gitHost: AppDeps["gitHost"];
}

/** How many owner rows each sweep marked this round, plus how many were left unmarked after an external deletion failed (they re-select next round). */
export interface RetentionSweepCounts {
  artifactRuns: number;
  logRuns: number;
  branchRuns: number;
  sessionStepRuns: number;
  webhookDeliveries: number;
  /** Runs/StepRuns whose blob or branch deletion threw — deliberately not marked, so a later round retries them. */
  failedRuns: number;
}

const DEFAULT_BATCH = 100;

/**
 * Runs all five sweeps once, oldest-first, batch-limited. Idempotent: running
 * it twice performs no deletion and touches no marker the second time, which
 * is exactly what the contract tests prove (test/sql/retention-sweeps.test.ts
 * for the SQL pairs, test/sql/retention-sweep-protocol.test.ts for the full
 * two-step protocol end to end).
 */
export async function runRetentionSweeps(
  deps: RetentionSweepDeps,
  options: { batch?: number } = {},
): Promise<RetentionSweepCounts> {
  const batch = options.batch ?? DEFAULT_BATCH;
  const counts: RetentionSweepCounts = {
    artifactRuns: 0,
    logRuns: 0,
    branchRuns: 0,
    sessionStepRuns: 0,
    webhookDeliveries: 0,
    failedRuns: 0,
  };

  counts.artifactRuns = await sweepRunBlobKind(deps, artifactCandidate, artifactMark, artifactBlobKeys, batch, counts);
  counts.logRuns = await sweepRunBlobKind(deps, logCandidate, logMark, logBlobKeys, batch, counts);
  counts.branchRuns = await sweepBranches(deps, branchCandidate, branchMark, batch, counts);
  counts.sessionStepRuns = await sweepSessions(deps, sessionCandidate, sessionMark, batch, counts);
  counts.webhookDeliveries = await sweepWebhookDeliveries(deps, webhookCandidate, webhookMark, batch);

  return counts;
}

async function candidateRunIds(
  deps: RetentionSweepDeps,
  statement: string,
  batch: number,
): Promise<Id<"run">[]> {
  const { rows } = await deps.pool.query<{ id: string }>(statement, [batch]);
  return rows.map((row) => row.id as Id<"run">);
}

async function markRuns(deps: RetentionSweepDeps, statement: string, ids: string[]): Promise<void> {
  await deps.pool.query(statement, [ids]);
}

/**
 * One blob-kind sweep (artifacts, logs): for each candidate Run, delete every
 * blob the Run's StepRuns recorded for that kind, then mark the Run. The
 * marker UPDATE is guarded by `IS NULL`, so a concurrent sweeper that marked
 * the run between our SELECT and UPDATE turns our UPDATE into a no-op.
 */
async function sweepRunBlobKind(
  deps: RetentionSweepDeps,
  selectSql: string,
  markSql: string,
  gatherKeys: (deps: RetentionSweepDeps, runId: Id<"run">) => Promise<string[]>,
  batch: number,
  counts: RetentionSweepCounts,
): Promise<number> {
  const runIds = await candidateRunIds(deps, selectSql, batch);
  let marked = 0;
  for (const runId of runIds) {
    try {
      const keys = await gatherKeys(deps, runId);
      await Promise.all(keys.map((key) => deps.objectStore.deleteObject(key)));
      await markRuns(deps, markSql, [runId]);
      marked += 1;
    } catch {
      counts.failedRuns += 1;
    }
  }
  return marked;
}

/**
 * The branch sweep. Per candidate Run: find every repo its StepRuns touched,
 * list the refs under `run/<run-id>` in each (recorded or orphan — the list
 * is the truth, not `output_ref_branch` rows), delete them, then mark the
 * Run. A repo that 404s or a ref that is already gone is not an error; a
 * genuinely failed host call leaves the Run unmarked for the next round.
 */
async function sweepBranches(
  deps: RetentionSweepDeps,
  selectSql: string,
  markSql: string,
  batch: number,
  counts: RetentionSweepCounts,
): Promise<number> {
  const runIds = await candidateRunIds(deps, selectSql, batch);
  let marked = 0;
  for (const runId of runIds) {
    try {
      // groupBy: a Run's StepRuns may share a repo (fan-out inside one repo);
      // mint once per repo, not once per StepRun.
      const repos = await deps.db
        .select({
          owner: repositories.owner,
          name: repositories.name,
          installationId: githubAppInstallations.installationId,
        })
        .from(stepRuns)
        .innerJoin(repositories, eq(repositories.id, stepRuns.repositoryId))
        .innerJoin(githubAppInstallations, eq(githubAppInstallations.id, repositories.githubAppInstallationId))
        .where(eq(stepRuns.runId, runId))
        .groupBy(repositories.owner, repositories.name, githubAppInstallations.installationId);

      const prefix = `run/${runId}`;
      for (const repo of repos) {
        const repoRef = { owner: repo.owner, name: repo.name };
        const token = await deps.gitHost.mintInstallationToken(repoRef, repo.installationId);
        const branches = await deps.gitHost.listRefsByPrefix(repoRef, prefix, token.token);
        for (const branch of branches) {
          await deps.gitHost.deleteRef(repoRef, branch, token.token);
        }
      }
      await markRuns(deps, markSql, [runId]);
      marked += 1;
    } catch {
      counts.failedRuns += 1;
    }
  }
  return marked;
}

/** The session sweep: delete each candidate StepRun's session blob, then mark it. */
async function sweepSessions(
  deps: RetentionSweepDeps,
  selectSql: string,
  markSql: string,
  batch: number,
  counts: RetentionSweepCounts,
): Promise<number> {
  const { rows } = await deps.pool.query<{ id: string }>(selectSql, [batch]);
  let marked = 0;
  for (const { id } of rows) {
    try {
      const [row] = await deps.db
        .select({ blobKey: stepRuns.sessionBlobKey })
        .from(stepRuns)
        .where(eq(stepRuns.id, id as Id<"steprun">));
      if (row?.blobKey) {
        await deps.objectStore.deleteObject(row.blobKey);
      }
      await deps.pool.query(markSql, [[id]]);
      marked += 1;
    } catch {
      counts.failedRuns += 1;
    }
  }
  return marked;
}

/**
 * The webhook-delivery sweep: no blob to delete — the whole "deletion" is
 * the marker write itself, which is why the two statements of the pair are
 * back to back here with nothing in between.
 */
async function sweepWebhookDeliveries(
  deps: RetentionSweepDeps,
  selectSql: string,
  markSql: string,
  batch: number,
): Promise<number> {
  const { rows } = await deps.pool.query<{ delivery_id: string }>(selectSql, [batch]);
  if (rows.length === 0) {
    return 0;
  }
  await deps.pool.query(markSql, [rows.map((row) => row.delivery_id)]);
  return rows.length;
}

/** Every artifact blob a Run's StepRuns recorded — the objects to delete before the artifact marker is written. */
async function artifactBlobKeys(deps: RetentionSweepDeps, runId: Id<"run">): Promise<string[]> {
  const rows = await deps.db
    .select({ blobKey: artifacts.blobKey })
    .from(artifacts)
    .innerJoin(stepRuns, eq(stepRuns.id, artifacts.stepRunId))
    .where(eq(stepRuns.runId, runId));
  return rows.map((row) => row.blobKey);
}

/** Every log chunk blob a Run's StepRuns recorded — the objects to delete before the log marker is written. */
async function logBlobKeys(deps: RetentionSweepDeps, runId: Id<"run">): Promise<string[]> {
  const rows = await deps.db
    .select({ blobKey: logChunks.blobKey })
    .from(logChunks)
    .innerJoin(stepRuns, eq(stepRuns.id, logChunks.stepRunId))
    .where(eq(stepRuns.runId, runId));
  return rows.map((row) => row.blobKey);
}

/** How often the sweeper wakes in production: hourly. Every threshold is days (90/30/1/1), so an hourly round is far finer than any of them. */
export const RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export interface RetentionSweeperHandle {
  stop(): void;
}

/**
 * The production background loop: one `runRetentionSweeps` round at startup
 * (after the listener opens — the retention sweep is not the boot barrier the
 * lease sweep is) and then one per hour. Started by `main.ts`; tests drive
 * `runRetentionSweeps` directly instead. A round's failure is logged and
 * skipped — the next round retries by construction.
 */
export function startRetentionSweeper(
  deps: RetentionSweepDeps,
  intervalMs: number = RETENTION_SWEEP_INTERVAL_MS,
): RetentionSweeperHandle {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const round = async (): Promise<void> => {
    if (stopped) return;
    try {
      await runRetentionSweeps(deps);
    } catch (error) {
      console.error("retention sweep failed", error instanceof Error ? error.message : String(error));
    }
    if (!stopped) {
      timer = setTimeout(() => void round(), intervalMs);
    }
  };

  void round();

  return {
    stop(): void {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
    },
  };
}
