/**
 * Contract test for `src/db/sql/claim_step_run.sql` — the hottest query in
 * the system (spec: "Runner: siklus hidup dan penjadwalan"; "Skema
 * database"). What this genuinely proves, against a real Postgres:
 *  - `ORDER BY ready_at` — FIFO, no priority.
 *  - tag containment (`required_tags <@ runner_tags`).
 *  - the `count(*) < $slots` fence, scoped to the calling lessee's own
 *    currently-held, unexpired leases.
 *  - `kind IS NOT DISTINCT FROM $5` routing ordinary StepRuns away from
 *    `kind: pull-request` StepRuns and back.
 *  - the `unschedulable_after > $6` deadline (issue #25): a `ready` row past
 *    its recorded deadline is refused, a future-deadline or deadline-less
 *    row is claimed.
 *  - `FOR UPDATE SKIP LOCKED` correctness under real concurrent callers: no
 *    row claimed twice, no row lost.
 * What it does NOT prove: Runner-side slot enforcement (poll stopping when
 * full) or the `426`/lease-expiry/heartbeat machinery around this query —
 * those belong to the Runner protocol issue that calls this query, not to
 * this file.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadSqlStatements, resetDatabase, startSqlRig, testIdGenerator, type SqlRig } from "./db-rig.js";
import { seedRunFixture, seedStepRun } from "./seed.js";

interface ClaimedStepRun {
  id: string;
  outcome: string;
  leased_by: string;
  lease_token: string;
  lease_expires_at: Date;
  started_at: Date;
  ready_at: Date;
  kind: string | null;
}

/** The query's `$6` — the caller's clock. Seeded rows carry explicit `unschedulable_after` values relative to this, so the deadline predicate is deterministic. */
const CLAIM_NOW = new Date("2026-01-01T00:00:00.000Z");

describe("claim_step_run.sql", () => {
  let rig: SqlRig;
  const ids = testIdGenerator();
  let fixture: Awaited<ReturnType<typeof seedRunFixture>>;
  const claimStatements = loadSqlStatements("claim_step_run.sql");
  if (claimStatements.length !== 1 || !claimStatements[0]) {
    throw new Error(
      `expected exactly 1 statement in claim_step_run.sql, got ${claimStatements.length}`,
    );
  }
  const claimQuery: string = claimStatements[0];

  async function claim(
    lesseeId: string,
    tags: string[],
    slots: number,
    leaseSeconds: number,
    wantedKind: string | null,
    now: Date,
  ): Promise<ClaimedStepRun[]> {
    const result = await rig.pool.query<ClaimedStepRun>(claimQuery, [
      lesseeId,
      tags,
      slots,
      leaseSeconds,
      wantedKind,
      now,
    ]);
    return result.rows;
  }

  beforeAll(async () => {
    rig = await startSqlRig();
  });

  afterAll(async () => {
    await rig.stop();
  });

  beforeEach(async () => {
    await resetDatabase(rig.pool);
    fixture = await seedRunFixture(rig.pool, ids);
  });

  it("claims the ready StepRun with the earliest ready_at first (FIFO)", async () => {
    const later = await seedStepRun(rig.pool, ids, {
      runId: fixture.runId,
      repositoryId: fixture.repositoryId,
      stepKey: "later",
      readyAt: new Date("2026-01-01T00:00:10.000Z"),
    });
    const earlier = await seedStepRun(rig.pool, ids, {
      runId: fixture.runId,
      repositoryId: fixture.repositoryId,
      stepKey: "earlier",
      readyAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const [claimed] = await claim("runner-1", [], 10, 30, null, CLAIM_NOW);

    expect(claimed?.id).toBe(earlier);
    expect(claimed?.id).not.toBe(later);
    expect(claimed?.outcome).toBe("running");
    expect(claimed?.leased_by).toBe("runner-1");
    expect(claimed?.lease_token).toBeTruthy();
    expect(claimed?.started_at).toBeTruthy();
  });

  it("does not claim a StepRun whose required_tags aren't a subset of the runner's tags", async () => {
    await seedStepRun(rig.pool, ids, {
      runId: fixture.runId,
      repositoryId: fixture.repositoryId,
      requiredTags: ["docker"],
    });

    const emptyHanded = await claim("runner-1", [], 10, 30, null, CLAIM_NOW);
    expect(emptyHanded).toHaveLength(0);

    const partialTags = await claim("runner-1", ["gpu"], 10, 30, null, CLAIM_NOW);
    expect(partialTags).toHaveLength(0);

    const matching = await claim("runner-1", ["docker", "linux"], 10, 30, null, CLAIM_NOW);
    expect(matching).toHaveLength(1);
  });

  it("fences on count(*) < $slots, scoped to the calling lessee's own unexpired leases", async () => {
    await seedStepRun(rig.pool, ids, { runId: fixture.runId, repositoryId: fixture.repositoryId, stepKey: "a" });
    await seedStepRun(rig.pool, ids, { runId: fixture.runId, repositoryId: fixture.repositoryId, stepKey: "b" });

    const first = await claim("runner-1", [], 1, 30, null, CLAIM_NOW);
    expect(first).toHaveLength(1);

    // Same lessee, slots=1, already holding one unexpired lease: fenced out
    // even though a second `ready` row exists.
    const second = await claim("runner-1", [], 1, 30, null, CLAIM_NOW);
    expect(second).toHaveLength(0);

    // A different lessee isn't scoped by runner-1's held count.
    const otherRunner = await claim("runner-2", [], 1, 30, null, CLAIM_NOW);
    expect(otherRunner).toHaveLength(1);
  });

  it("does not count an expired lease against the fence", async () => {
    await seedStepRun(rig.pool, ids, {
      runId: fixture.runId,
      repositoryId: fixture.repositoryId,
      stepKey: "held-but-expired",
      outcome: "running",
      leasedBy: "runner-1",
      leaseExpiresAt: new Date(Date.now() - 60_000),
    });
    await seedStepRun(rig.pool, ids, {
      runId: fixture.runId,
      repositoryId: fixture.repositoryId,
      stepKey: "ready-one",
    });

    const claimed = await claim("runner-1", [], 1, 30, null, CLAIM_NOW);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.id).not.toBe(undefined);
  });

  it("routes kind: pull-request StepRuns only to callers that ask for that kind", async () => {
    const ordinary = await seedStepRun(rig.pool, ids, {
      runId: fixture.runId,
      repositoryId: fixture.repositoryId,
      stepKey: "ordinary",
      kind: null,
    });
    const prStep = await seedStepRun(rig.pool, ids, {
      runId: fixture.runId,
      repositoryId: fixture.repositoryId,
      stepKey: "open-pr",
      kind: "pull-request",
    });

    const runnerClaim = await claim("runner-1", [], 10, 30, null, CLAIM_NOW);
    expect(runnerClaim.map((r) => r.id)).toEqual([ordinary]);

    // The control-plane lessee asks for kind: pull-request with a 60-second
    // lease (issue #17, AC1) — the same query, a different caller.
    const controlPlaneClaim = await claim("control-plane-1", [], 10, 60, "pull-request", CLAIM_NOW);
    expect(controlPlaneClaim.map((r) => r.id)).toEqual([prStep]);
    const leaseDelta = await rig.pool.query<{ seconds: number }>(
      `select extract(epoch from (lease_expires_at - now()))::int as seconds from step_runs where id = $1`,
      [prStep],
    );
    expect(leaseDelta.rows[0]?.seconds).toBe(60);
  });

  it("under concurrent callers, claims every ready row exactly once (FOR UPDATE SKIP LOCKED)", async () => {
    const seeded = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        seedStepRun(rig.pool, ids, {
          runId: fixture.runId,
          repositoryId: fixture.repositoryId,
          stepKey: `concurrent-${i}`,
          readyAt: new Date(Date.now() + i),
        }),
      ),
    );

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => claim(`runner-concurrent-${i}`, [], 10, 30, null, CLAIM_NOW)),
    );

    const claimedIds = results.flat().map((r) => r.id);
    expect(claimedIds).toHaveLength(8);
    expect(new Set(claimedIds).size).toBe(8);
    expect(new Set(claimedIds)).toEqual(new Set(seeded));

    const { rows } = await rig.pool.query<{ count: string }>(
      `select count(*) from step_runs where run_id = $1 and outcome = 'running'`,
      [fixture.runId],
    );
    expect(rows[0]?.count).toBe("8");
  });

  it("does not claim a ready StepRun whose recorded unschedulable_after has passed, while a future-deadline one is claimable", async () => {
    // Past deadline: the row's window is over — the query refuses it even
    // though it is `ready` and would otherwise be the FIFO winner.
    await seedStepRun(rig.pool, ids, {
      runId: fixture.runId,
      repositoryId: fixture.repositoryId,
      stepKey: "expired",
      readyAt: new Date("2025-12-31T20:00:00.000Z"),
      unschedulableAfter: new Date("2025-12-31T22:00:00.000Z"),
    });
    // Future deadline: still inside its window.
    await seedStepRun(rig.pool, ids, {
      runId: fixture.runId,
      repositoryId: fixture.repositoryId,
      stepKey: "still-claimable",
      readyAt: new Date("2025-12-31T23:00:00.000Z"),
      unschedulableAfter: new Date("2026-01-01T02:00:00.000Z"),
    });

    const claimed = await claim("runner-1", [], 10, 30, null, CLAIM_NOW);
    expect(claimed.map((r) => r.id)).toHaveLength(1);
    const { rows } = await rig.pool.query<{ step_key: string }>(
      `select step_key from step_runs where id = $1`,
      [claimed[0]!.id],
    );
    expect(rows[0]?.step_key).toBe("still-claimable");
  });

  it("claims a ready StepRun without a recorded deadline even when the clock is past every stamped deadline", async () => {
    await seedStepRun(rig.pool, ids, {
      runId: fixture.runId,
      repositoryId: fixture.repositoryId,
      stepKey: "no-deadline",
      readyAt: new Date("2025-01-01T00:00:00.000Z"),
      unschedulableAfter: null,
    });

    const claimed = await claim("runner-1", [], 10, 30, null, CLAIM_NOW);
    expect(claimed).toHaveLength(1);
  });

  it("returns nothing when there is no ready StepRun to claim", async () => {
    const claimed = await claim("runner-1", [], 10, 30, null, CLAIM_NOW);
    expect(claimed).toHaveLength(0);
  });
});
