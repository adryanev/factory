/**
 * Contract test for the full retention-sweep protocol — the SQL pairs of
 * `retention_sweeps.sql` PLUS the application half (`domain/retention-sweeps.ts`)
 * that sits between them: SELECT candidates, delete the blobs/branches the
 * markers stand for, then UPDATE the markers. Runs against a real Postgres
 * (SQL rig, same as the other hand-written-SQL tests) with the seam-1 fakes
 * for the object store and the git host — no HTTP app, no network.
 *
 * What this proves, on top of `retention-sweeps.test.ts` (which exercises
 * only the SQL statements):
 *  - the whole protocol is **idempotent end to end**: run twice → the second
 *    round selects nothing, deletes nothing, touches no marker, and returns
 *    identical counts;
 *  - blob keys are gathered from recorded rows and deleted before the marker
 *    is written — a failure mid-deletion leaves the owner unmarked, and the
 *    next round finishes the job (crash-safety the SQL pair alone cannot
 *    show);
 *  - **orphan branches from dead turns** are reclaimed: the branch sweep
 *    lists refs by the `run/<run-id>` prefix, so a pushed branch no row ever
 *    recorded is deleted the same way as a recorded one — and another Run's
 *    branches survive;
 *  - cost retention is untouched: no sweep deletes `runs`, `step_runs`, or
 *    `step_run_costs` rows (spec: "tidak pernah kedaluwarsa, seumur baris
 *    Run") — the markers are the only write;
 *  - a Run with no StepRuns and no blobs is still marked — the cleanup fact
 *    is recorded even when there was nothing to reclaim.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { createDatabase } from "../../src/db/client.js";
import { runRetentionSweeps } from "../../src/domain/retention-sweeps.js";
import type { ObjectStore } from "../../src/object-store.js";
import { createFakeObjectStore } from "../seam1/fake-object-store.js";
import { createFakeGitHost } from "../seam1/fake-git-host.js";
import {
  resetDatabase,
  startSqlRig,
  testIdGenerator,
  type SqlRig,
} from "./db-rig.js";
import {
  seedProjectRepoPrincipal,
  seedRun,
  seedStepRun,
  seedWebhookDelivery,
} from "./seed.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const now = () => new Date();
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS);
const hoursAgo = (n: number) => new Date(Date.now() - n * (60 * 60 * 1000));

const ZERO_COUNTS = {
  artifactRuns: 0,
  logRuns: 0,
  branchRuns: 0,
  sessionStepRuns: 0,
  webhookDeliveries: 0,
  failedRuns: 0,
};

describe("retention sweep protocol (SELECT → delete → mark)", () => {
  let rig: SqlRig;
  const ids = testIdGenerator();
  let chain: Awaited<ReturnType<typeof seedProjectRepoPrincipal>>;
  let objectStore: ReturnType<typeof createFakeObjectStore>;
  let gitHost: ReturnType<typeof createFakeGitHost>;

  function sweepDeps(pool: Pool) {
    return {
      db: createDatabase(pool),
      pool,
      objectStore,
      gitHost,
    };
  }

  beforeAll(async () => {
    rig = await startSqlRig();
  });

  afterAll(async () => {
    await rig.stop();
  });

  beforeEach(async () => {
    await resetDatabase(rig.pool);
    chain = await seedProjectRepoPrincipal(rig.pool, ids);
    objectStore = createFakeObjectStore();
    gitHost = createFakeGitHost();
  });

  it("reclaims blobs, sessions, branches (incl. orphans), and webhook rows; second run identical", async () => {
    // Run A: ended 120 days ago — every sweep fires.
    const runA = await seedRun(rig.pool, ids, chain, { endedAt: daysAgo(120) });
    const stepA = await seedStepRun(rig.pool, ids, {
      runId: runA,
      repositoryId: chain.repositoryId,
      outcome: "succeeded",
      sessionBlobKey: "session/run-a",
    });

    const artifactBlobA = `artifact/${stepA}/a1`;
    const artifactBlobB = `artifact/${stepA}/a2`;
    const logBlob = `log/${stepA}/1/0`;
    for (const key of [artifactBlobA, artifactBlobB, logBlob, "session/run-a"]) {
      objectStore.objects.set(key, "payload");
    }

    await rig.pool.query(
      `insert into artifacts (id, step_run_id, key, kind, content_type, blob_key, size_bytes, created_at)
       values ($1, $2, 'a1', 'document', 'text/markdown', $3, 42, $5), ($1 || '-2', $2, 'a2', 'document', 'text/markdown', $4, 7, $5)`,
      [ids.next("artifact"), stepA, artifactBlobA, artifactBlobB, now()],
    );
    await rig.pool.query(
      `insert into log_chunks (step_run_id, attempt, seq, byte_offset, size, blob_key) values ($1, 1, 0, 0, 4, $2)`,
      [stepA, logBlob],
    );
    // Cost rows must survive the sweep untouched (spec: cost never expires).
    await rig.pool.query(
      `insert into step_run_costs (step_run_id, attempt, tokens, cost_usd, price_version) values ($1, 1, null, null, null)`,
      [stepA],
    );

    // Branches in the run's repo: one recorded in output_ref_branch, one
    // orphan (a dead turn pushed it, no row ever recorded it), one belonging
    // to a different Run that must survive.
    const repoRef = { owner: "fixture-owner", name: `fixture-repo-${chain.repositoryId}` };
    gitHost.registerRef(repoRef, `run/${runA}/implement/t1-a1`, "sha-recorded");
    gitHost.registerRef(repoRef, `run/${runA}/ghost/t1-a1`, "sha-orphan");
    gitHost.registerRef(repoRef, `run/run_other/implement/t1-a1`, "sha-other-run");
    await rig.pool.query(
      `update step_runs set output_ref_branch = $1, output_ref_sha = 'sha-recorded' where id = $2`,
      [`run/${runA}/implement/t1-a1`, stepA],
    );

    // Run B: still in flight — must be left completely alone despite having
    // blobs and branches.
    const runB = await seedRun(rig.pool, ids, chain, { endedAt: null });
    const stepB = await seedStepRun(rig.pool, ids, {
      runId: runB,
      repositoryId: chain.repositoryId,
      outcome: "running",
      sessionBlobKey: "session/run-b",
    });
    const runBBlob = `artifact/${stepB}/b1`;
    objectStore.objects.set(runBBlob, "payload");
    objectStore.objects.set("session/run-b", "payload");
    await rig.pool.query(
      `insert into artifacts (id, step_run_id, key, kind, content_type, blob_key, size_bytes, created_at)
       values ($1, $2, 'b1', 'document', 'text/markdown', $3, 1, $4)`,
      [ids.next("artifact"), stepB, runBBlob, now()],
    );
    gitHost.registerRef(repoRef, `run/${runB}/implement/t1-a1`, "sha-running");

    // Run C: ended, but never had a StepRun — still gets marked.
    const runC = await seedRun(rig.pool, ids, chain, { endedAt: daysAgo(400) });

    // A webhook delivery past the 24h window.
    await seedWebhookDelivery(rig.pool, "delivery-1", hoursAgo(30));

    const deps = sweepDeps(rig.pool);

    const first = await runRetentionSweeps(deps);
    // A (120d) and C (400d, no StepRuns) are both candidates for the run
    // sweeps — C is marked too (asserted below), so artifact/log/branch
    // counts are 2, not 1.
    expect(first).toEqual({ ...ZERO_COUNTS, artifactRuns: 2, logRuns: 2, branchRuns: 2, sessionStepRuns: 1, webhookDeliveries: 1 });

    // Blobs reclaimed.
    expect(objectStore.deleted).toEqual([artifactBlobA, artifactBlobB, logBlob, "session/run-a"]);
    expect(objectStore.objects.has(artifactBlobA)).toBe(false);
    expect(objectStore.objects.has(runBBlob)).toBe(true);
    expect(objectStore.objects.has("session/run-b")).toBe(true);

    // Branches reclaimed by prefix — including the orphan; other runs survive.
    // The fake host lists refs lexicographically, so order is the host's, not
    // the sweep's — compare sorted.
    expect(gitHost.deletedRefs.map((d) => d.branch).sort()).toEqual(
      [`run/${runA}/implement/t1-a1`, `run/${runA}/ghost/t1-a1`].sort(),
    );
    expect(gitHost.deletedRefs.map((d) => d.branch)).not.toContain(`run/${runB}/implement/t1-a1`);

    // Markers recorded on A and C; B untouched.
    const { rows: runRows } = await rig.pool.query<{
      id: string;
      artifacts_purged_at: Date | null;
      logs_purged_at: Date | null;
      branches_purged_at: Date | null;
    }>(
      `select id, artifacts_purged_at, logs_purged_at, branches_purged_at from runs where id = any($1::text[]) order by id`,
      [[runA, runB, runC]],
    );
    expect(runRows[0]!.artifacts_purged_at).toBeTruthy();
    expect(runRows[0]!.logs_purged_at).toBeTruthy();
    expect(runRows[0]!.branches_purged_at).toBeTruthy();
    expect(runRows[2]!.artifacts_purged_at).toBeTruthy();
    expect(runRows[2]!.logs_purged_at).toBeTruthy();
    expect(runRows[2]!.branches_purged_at).toBeTruthy();
    expect(runRows[1]!.artifacts_purged_at).toBeNull();
    expect(runRows[1]!.branches_purged_at).toBeNull();

    const { rows: sessionRows } = await rig.pool.query<{ session_purged_at: Date | null }>(
      `select session_purged_at from step_runs where id = $1`,
      [stepA],
    );
    expect(sessionRows[0]!.session_purged_at).toBeTruthy();
    const { rows: sessionBRows } = await rig.pool.query<{ session_purged_at: Date | null }>(
      `select session_purged_at from step_runs where id = $1`,
      [stepB],
    );
    expect(sessionBRows[0]!.session_purged_at).toBeNull();

    const { rows: deliveryRows } = await rig.pool.query<{ purged_at: Date | null; payload: unknown }>(
      `select purged_at, payload from webhook_deliveries where delivery_id = 'delivery-1'`,
    );
    expect(deliveryRows[0]!.purged_at).toBeTruthy();
    // Issue #23: the purge clears the delivery's raw event bytes while the
    // row (the layer-1 dedup key) survives.
    expect(deliveryRows[0]!.payload).toBeNull();

    // Cost retention: rows and their tables untouched.
    const { rows: costs } = await rig.pool.query(
      `select step_run_id from step_run_costs where step_run_id = $1`,
      [stepA],
    );
    expect(costs).toHaveLength(1);

    // Second sweep: identical zero counts, no deletion, no marker movement.
    const markerBefore = await rig.pool.query<{ artifacts_purged_at: Date }>(
      `select artifacts_purged_at from runs where id = $1`,
      [runA],
    );
    const second = await runRetentionSweeps(deps);
    expect(second).toEqual(ZERO_COUNTS);
    expect(objectStore.deleted).toHaveLength(4);
    expect(gitHost.deletedRefs).toHaveLength(2);
    const markerAfter = await rig.pool.query<{ artifacts_purged_at: Date }>(
      `select artifacts_purged_at from runs where id = $1`,
      [runA],
    );
    expect(markerAfter.rows[0]!.artifacts_purged_at).toEqual(markerBefore.rows[0]!.artifacts_purged_at);
    const { rows: costsAfter } = await rig.pool.query(
      `select step_run_id from step_run_costs where step_run_id = $1`,
      [stepA],
    );
    expect(costsAfter).toHaveLength(1);
  });

  it("a failed blob deletion leaves the owner unmarked; the next round finishes it", async () => {
    const runA = await seedRun(rig.pool, ids, chain, { endedAt: daysAgo(120) });
    const stepA = await seedStepRun(rig.pool, ids, {
      runId: runA,
      repositoryId: chain.repositoryId,
      outcome: "succeeded",
    });
    const blob1 = `artifact/${stepA}/ok`;
    const blob2 = `artifact/${stepA}/failing`;
    objectStore.objects.set(blob1, "payload");
    objectStore.objects.set(blob2, "payload");
    await rig.pool.query(
      `insert into artifacts (id, step_run_id, key, kind, content_type, blob_key, size_bytes, created_at)
       values ($1, $2, 'ok', 'document', 'text/markdown', $3, 1, $4), ($1 || '-2', $2, 'failing', 'document', 'text/markdown', $5, 1, $4)`,
      [ids.next("artifact"), stepA, blob1, now(), blob2],
    );

    // The store fails on one key this round — the runner must leave the run
    // unmarked so a later round retries.
    const flaky: ObjectStore = {
      ...objectStore,
      deleteObject: async (key) => {
        if (key === blob2) {
          throw new Error("garage delete failed: 503");
        }
        await objectStore.deleteObject(key);
      },
    };

    // The failure must be observable, not just counted: an operator reading
    // the log needs the row, the sweep, and the cause to tell a transient
    // 503 apart from a permanent 404 without re-deriving either from a bare
    // failure count.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const deps = sweepDeps(rig.pool);
    const first = await runRetentionSweeps({ ...deps, objectStore: flaky });
    expect(first.artifactRuns).toBe(0);
    expect(first.failedRuns).toBe(1);

    expect(consoleError).toHaveBeenCalledTimes(1);
    const [message, cause] = consoleError.mock.calls[0]!;
    expect(message).toContain("artifact");
    expect(message).toContain(runA);
    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).message).toBe("garage delete failed: 503");
    consoleError.mockRestore();

    const afterFailure = await rig.pool.query<{ artifacts_purged_at: Date | null }>(
      `select artifacts_purged_at from runs where id = $1`,
      [runA],
    );
    expect(afterFailure.rows[0]!.artifacts_purged_at).toBeNull();

    // Next round, healthy store: the run re-selects, the already-deleted blob
    // is deleted again (idempotent), the failing one goes too, and the marker
    // lands.
    const second = await runRetentionSweeps(deps);
    expect(second.artifactRuns).toBe(1);
    expect(second.failedRuns).toBe(0);
    expect(objectStore.objects.has(blob1)).toBe(false);
    expect(objectStore.objects.has(blob2)).toBe(false);
    const afterRecovery = await rig.pool.query<{ artifacts_purged_at: Date | null }>(
      `select artifacts_purged_at from runs where id = $1`,
      [runA],
    );
    expect(afterRecovery.rows[0]!.artifacts_purged_at).toBeTruthy();
  });

  it("sweeps mark only when the run ended — a still-running run is never touched even past every threshold", async () => {
    const runA = await seedRun(rig.pool, ids, chain, { endedAt: daysAgo(500) });
    const runB = await seedRun(rig.pool, ids, chain, { endedAt: null });
    const stepB = await seedStepRun(rig.pool, ids, {
      runId: runB,
      repositoryId: chain.repositoryId,
      outcome: "awaiting-human",
      sessionBlobKey: "session/old-but-running",
    });
    objectStore.objects.set("session/old-but-running", "payload");

    const deps = sweepDeps(rig.pool);
    const counts = await runRetentionSweeps(deps);
    expect(counts.artifactRuns).toBe(1);
    expect(counts.branchRuns).toBe(1);
    expect(counts.sessionStepRuns).toBe(0);
    expect(objectStore.deleted).toEqual([]);

    const { rows: sessionRows } = await rig.pool.query<{ session_purged_at: Date | null }>(
      `select session_purged_at from step_runs where id = $1`,
      [stepB],
    );
    expect(sessionRows[0]!.session_purged_at).toBeNull();
  });

  it("is idempotent even when rows were already marked by an earlier sweep", async () => {
    const runA = await seedRun(rig.pool, ids, chain, {
      endedAt: daysAgo(120),
      artifactsPurgedAt: now(),
      logsPurgedAt: now(),
      branchesPurgedAt: now(),
    });
    const stepA = await seedStepRun(rig.pool, ids, {
      runId: runA,
      repositoryId: chain.repositoryId,
      outcome: "succeeded",
      sessionBlobKey: "session/already-purged",
      sessionPurgedAt: now(),
    });
    objectStore.objects.set("session/already-purged", "payload");
    await seedWebhookDelivery(rig.pool, "delivery-old", hoursAgo(30), now());

    const deps = sweepDeps(rig.pool);
    const counts = await runRetentionSweeps(deps);
    expect(counts).toEqual(ZERO_COUNTS);
    expect(objectStore.deleted).toEqual([]);
    expect(gitHost.deletedRefs).toEqual([]);

    // The guard is the IS NULL in the marker UPDATE, not just "not selected
    // again" — a stale re-mark with the same id list must touch nothing.
    const { rowCount } = await rig.pool.query(
      `update runs set artifacts_purged_at = now() where id = $1 and artifacts_purged_at is null`,
      [runA],
    );
    expect(rowCount).toBe(0);
    const { rows: markerRows } = await rig.pool.query<{ artifacts_purged_at: Date }>(
      `select artifacts_purged_at from runs where id = $1`,
      [runA],
    );
    expect(markerRows[0]!.artifacts_purged_at).toBeTruthy();
  });
});
