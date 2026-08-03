/**
 * Contract test for `src/db/sql/retention_sweeps.sql` — four sweeps, each a
 * SELECT-candidates + UPDATE-marks-purged pair the application runs as two
 * steps (spec: "Artifact dan blob"; "Skema database"). What this genuinely
 * proves, against a real Postgres:
 *  - every sweep's candidate SELECT demands `ended_at IS NOT NULL` (a Run
 *    still in flight is never a candidate, regardless of how old it is).
 *  - the age threshold (90d / 30d / none / none) is applied correctly.
 *  - `ORDER BY ended_at` — oldest first.
 *  - running the SELECT+UPDATE pair twice is idempotent: the second UPDATE
 *    touches zero rows and does not move the `*_purged_at` timestamp.
 * What it does NOT prove: the actual blob/branch deletion the application
 * is supposed to perform between SELECT and UPDATE (spec: "aplikasi
 * menghapus objek Garage / branch git ... di luar transaksi SQL ini") — no
 * such deleter exists yet, so these tests only exercise the SQL's own
 * correctness, not the two-step protocol's crash-safety end to end.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  loadSqlStatements,
  resetDatabase,
  startSqlRig,
  testIdGenerator,
  type SqlRig,
} from "./db-rig.js";
import { seedProjectRepoPrincipal, seedRun, seedStepRun } from "./seed.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const now = () => new Date();
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS);

describe("retention_sweeps.sql", () => {
  let rig: SqlRig;
  const ids = testIdGenerator();
  let chain: Awaited<ReturnType<typeof seedProjectRepoPrincipal>>;

  const statements = loadSqlStatements("retention_sweeps.sql");
  const [
    artifactSelect,
    artifactUpdate,
    logSelect,
    logUpdate,
    branchSelect,
    branchUpdate,
    sessionSelect,
    sessionUpdate,
  ] = statements;
  if (statements.length !== 8) {
    throw new Error(
      `expected 8 statements (4 SELECT/UPDATE pairs) in retention_sweeps.sql, got ${statements.length}`,
    );
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
  });

  describe("artifact sweep (90 days since ended_at)", () => {
    it("only selects ended, unpurged runs older than 90 days, oldest first", async () => {
      const stillRunning = await seedRun(rig.pool, ids, chain, { endedAt: null });
      const tooRecent = await seedRun(rig.pool, ids, chain, { endedAt: daysAgo(10) });
      const oldest = await seedRun(rig.pool, ids, chain, { endedAt: daysAgo(200) });
      const old = await seedRun(rig.pool, ids, chain, { endedAt: daysAgo(91) });
      const alreadyPurged = await seedRun(rig.pool, ids, chain, {
        endedAt: daysAgo(365),
        artifactsPurgedAt: now(),
      });

      const { rows } = await rig.pool.query<{ id: string }>(artifactSelect!, [10]);
      const candidateIds = rows.map((r) => r.id);

      expect(candidateIds).toEqual([oldest, old]);
      expect(candidateIds).not.toContain(stillRunning);
      expect(candidateIds).not.toContain(tooRecent);
      expect(candidateIds).not.toContain(alreadyPurged);
    });

    it("marking candidates purged is idempotent across two runs", async () => {
      const eligible = await seedRun(rig.pool, ids, chain, { endedAt: daysAgo(120) });

      const first = await rig.pool.query<{ id: string }>(artifactSelect!, [10]);
      expect(first.rows.map((r) => r.id)).toEqual([eligible]);

      await rig.pool.query(artifactUpdate!, [first.rows.map((r) => r.id)]);
      const { rows: afterFirst } = await rig.pool.query<{ artifacts_purged_at: Date }>(
        `select artifacts_purged_at from runs where id = $1`,
        [eligible],
      );
      const purgedAt = afterFirst[0]?.artifacts_purged_at;
      expect(purgedAt).toBeTruthy();

      // Second sweep: the row is no longer a candidate, so the second
      // UPDATE — even if the application mistakenly re-ran it with the same
      // id list — must not move the timestamp (the `IS NULL` guard, not
      // just "the row wasn't selected again").
      const second = await rig.pool.query<{ id: string }>(artifactSelect!, [10]);
      expect(second.rows).toHaveLength(0);

      const result = await rig.pool.query(artifactUpdate!, [[eligible]]);
      expect(result.rowCount).toBe(0);

      const { rows: afterSecond } = await rig.pool.query<{ artifacts_purged_at: Date }>(
        `select artifacts_purged_at from runs where id = $1`,
        [eligible],
      );
      expect(afterSecond[0]?.artifacts_purged_at).toEqual(purgedAt);
    });
  });

  describe("log sweep (30 days since ended_at)", () => {
    it("uses a 30-day threshold, independent of the artifact sweep's 90-day one", async () => {
      const between30and90 = await seedRun(rig.pool, ids, chain, { endedAt: daysAgo(45) });
      const under30 = await seedRun(rig.pool, ids, chain, { endedAt: daysAgo(10) });

      const { rows } = await rig.pool.query<{ id: string }>(logSelect!, [10]);
      const candidateIds = rows.map((r) => r.id);

      expect(candidateIds).toContain(between30and90);
      expect(candidateIds).not.toContain(under30);
    });
  });

  describe("branch sweep (as soon as the Run ends, no window)", () => {
    it("selects a Run the instant ended_at is set, not after a wait", async () => {
      const justEnded = await seedRun(rig.pool, ids, chain, { endedAt: now() });

      const { rows } = await rig.pool.query<{ id: string }>(branchSelect!, [10]);
      expect(rows.map((r) => r.id)).toContain(justEnded);
    });

    it("still demands ended_at IS NOT NULL", async () => {
      const stillRunning = await seedRun(rig.pool, ids, chain, { endedAt: null });

      const { rows } = await rig.pool.query<{ id: string }>(branchSelect!, [10]);
      expect(rows.map((r) => r.id)).not.toContain(stillRunning);
    });

    it("is idempotent", async () => {
      const runId = await seedRun(rig.pool, ids, chain, { endedAt: now() });

      await rig.pool.query(branchUpdate!, [[runId]]);
      const second = await rig.pool.query(branchUpdate!, [[runId]]);

      expect(second.rowCount).toBe(0);
    });
  });

  describe("session sweep (StepRun not awaiting-human AND Run ended)", () => {
    it("requires both predicates — neither alone is enough", async () => {
      const stillAwaitingButRunEnded = await seedRun(rig.pool, ids, chain, { endedAt: now() });
      await seedStepRun(rig.pool, ids, {
        runId: stillAwaitingButRunEnded,
        repositoryId: chain.repositoryId,
        outcome: "awaiting-human",
        sessionBlobKey: "session/one",
      });

      const doneButRunStillOpen = await seedRun(rig.pool, ids, chain, { endedAt: null });
      await seedStepRun(rig.pool, ids, {
        runId: doneButRunStillOpen,
        repositoryId: chain.repositoryId,
        outcome: "succeeded",
        sessionBlobKey: "session/two",
      });

      const eligibleRun = await seedRun(rig.pool, ids, chain, { endedAt: now() });
      const eligibleStepRun = await seedStepRun(rig.pool, ids, {
        runId: eligibleRun,
        repositoryId: chain.repositoryId,
        outcome: "succeeded",
        sessionBlobKey: "session/three",
      });

      const { rows } = await rig.pool.query<{ id: string }>(sessionSelect!, [10]);
      const candidateIds = rows.map((r) => r.id);

      expect(candidateIds).toEqual([eligibleStepRun]);
    });

    it("excludes StepRuns with no session to purge", async () => {
      const runId = await seedRun(rig.pool, ids, chain, { endedAt: now() });
      const noSession = await seedStepRun(rig.pool, ids, {
        runId,
        repositoryId: chain.repositoryId,
        outcome: "succeeded",
        sessionBlobKey: null,
      });

      const { rows } = await rig.pool.query<{ id: string }>(sessionSelect!, [10]);
      expect(rows.map((r) => r.id)).not.toContain(noSession);
    });

    it("is idempotent", async () => {
      const runId = await seedRun(rig.pool, ids, chain, { endedAt: now() });
      const stepRunId = await seedStepRun(rig.pool, ids, {
        runId,
        repositoryId: chain.repositoryId,
        outcome: "succeeded",
        sessionBlobKey: "session/idempotent",
      });

      await rig.pool.query(sessionUpdate!, [[stepRunId]]);
      const second = await rig.pool.query(sessionUpdate!, [[stepRunId]]);

      expect(second.rowCount).toBe(0);
    });
  });
});
