/**
 * Contract test for the `step_runs` natural key — the structural half of
 * "Key duplikat menggagalkan Run saat fan-out" (issue #11, AC2; spec:
 * "Skema database"):
 *
 *   UNIQUE NULLS NOT DISTINCT (run_id, step_key, branch_key, turn)
 *
 * What this genuinely proves, against a real Postgres:
 *  - two fan-out branches of the same StepRun with the same Key and turn
 *    cannot coexist (23505) — the fan-out transaction that tried to insert
 *    them fails whole, which is what makes a duplicate Key fail the Run;
 *  - a non-fan-out StepRun (`branch_key NULL`) and a fan-out branch
 *    (`branch_key 'x'`) of the same Step *can* coexist — NULL means "this
 *    Step has no Key", distinct by meaning, not by accident;
 *  - two non-fan-out StepRuns of the same Step and turn cannot coexist;
 *  - the empty-string sentinel is rejected by the `branch_key` CHECK —
 *    NULL is the only spelling of "no Key".
 *
 * A note on case: the constraint compares raw strings, so `Frontend` and
 * `frontend` would *not* collide here — they are two distinct values, and
 * the Key pattern (lowercase-only, no slug normalisation, issue #11 AC4) is
 * what keeps a case-differing pair from ever reaching this table in the
 * first place. This test proves the constraint and the sentinel rule; the
 * no-normalisation rule lives in the shared validator + seam-1 tests.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Id } from "@factory/shared";
import {
  resetDatabase,
  startSqlRig,
  testIdGenerator,
  type SqlRig,
} from "./db-rig.js";
import { seedProjectRepoPrincipal, seedRun, seedStepRun } from "./seed.js";

describe("step_runs natural key (run_id, step_key, branch_key, turn) NULLS NOT DISTINCT", () => {
  let rig: SqlRig;
  const ids = testIdGenerator();
  let chain: Awaited<ReturnType<typeof seedProjectRepoPrincipal>>;
  let runId: Id<"run">;

  beforeAll(async () => {
    rig = await startSqlRig();
  });

  afterAll(async () => {
    await rig.stop();
  });

  beforeEach(async () => {
    await resetDatabase(rig.pool);
    chain = await seedProjectRepoPrincipal(rig.pool, ids);
    runId = await seedRun(rig.pool, ids, chain);
  });

  it("rejects a second branch with the same Key and turn (23505)", async () => {
    const first = await seedStepRun(rig.pool, ids, {
      runId,
      repositoryId: chain.repositoryId,
      stepKey: "implement",
      branchKey: "frontend",
      turn: 1,
    });
    expect(first).toBeTruthy();

    // The second fan-out branch with the same Key collides on the natural
    // key — the fan-out transaction inserting both rows fails whole, which
    // is the structural backstop for "duplicate Key fails the Run".
    const second = seedStepRun(rig.pool, ids, {
      runId,
      repositoryId: chain.repositoryId,
      stepKey: "implement",
      branchKey: "frontend",
      turn: 1,
    });
    await expect(second).rejects.toMatchObject({ code: "23505" });
  });

  it("lets a fan-out branch and the same Step's non-fan-out row coexist — NULL means 'no Key'", async () => {
    const branch = await seedStepRun(rig.pool, ids, {
      runId,
      repositoryId: chain.repositoryId,
      stepKey: "implement",
      branchKey: "agent-a",
      turn: 1,
    });
    const plain = await seedStepRun(rig.pool, ids, {
      runId,
      repositoryId: chain.repositoryId,
      stepKey: "implement",
      branchKey: null,
      turn: 1,
    });
    expect(branch).toBeTruthy();
    expect(plain).toBeTruthy();
  });

  it("rejects two non-fan-out rows of the same Step and turn — NULLs are NOT DISTINCT", async () => {
    await seedStepRun(rig.pool, ids, {
      runId,
      repositoryId: chain.repositoryId,
      stepKey: "build",
      branchKey: null,
      turn: 1,
    });
    const second = seedStepRun(rig.pool, ids, {
      runId,
      repositoryId: chain.repositoryId,
      stepKey: "build",
      branchKey: null,
      turn: 1,
    });
    await expect(second).rejects.toMatchObject({ code: "23505" });
  });

  it("rejects the empty-string sentinel for branch_key — NULL is the only spelling of 'no Key'", async () => {
    const attempt = seedStepRun(rig.pool, ids, {
      runId,
      repositoryId: chain.repositoryId,
      stepKey: "implement",
      branchKey: "",
      turn: 1,
    });
    await expect(attempt).rejects.toMatchObject({ code: "23514" }); // check_violation
  });
});
