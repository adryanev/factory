/**
 * AC5: "Lease 30 detik diperbarui heartbeat 10 detik; lease hilang -> sweep
 * -> dijadwalkan ulang sebagai attempt baru dengan reason tercatat
 * terpisah."
 * AC6: "Sweep dijalankan sebelum listener dibuka saat startup."
 * AC7: "`unknown_leases` di balasan heartbeat terpisah dari `cancel` — test
 * membuktikan operator bisa membedakan 'dibatalkan orang' dari 'kehilangan
 * lease'."
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { MIGRATIONS_FOLDER } from "../../src/db/migrations-path.js";
import { createClaimConnectionLimiter, type AppDeps } from "../../src/deps.js";
import { createDatabase } from "../../src/db/client.js";
import { bootstrapBreakGlassAccount } from "../../src/domain/auth.js";
import { bootControlPlane } from "../../src/boot.js";
import { createFakeGithubOAuthClient } from "./fake-github-oauth.js";
import { createFakeGitHost } from "./fake-git-host.js";
import { startTestRig, type TestRig } from "./setup.js";
import { joinRunner, realIdGenerator, seedReadyStepRun } from "./runner-test-helpers.js";
import { testIdGenerator } from "../sql/db-rig.js";
import { seedRunFixture, seedStepRun } from "../sql/seed.js";

describe("Runner protocol: heartbeat, lease renewal, and the lease sweep", () => {
  let rig: TestRig;
  let ownerCookie: string;

  beforeAll(async () => {
    rig = await startTestRig();
    ownerCookie = await rig.loginAsBreakGlass();
  });

  afterAll(async () => {
    await rig.stop();
  });

  it("renews a held lease's expiry via heartbeat", async () => {
    const { secret, client } = await joinRunner(rig, ownerCookie);
    const { stepRunId } = await seedReadyStepRun(rig.pool);

    const claimed = await client.claim(secret);
    const stepRun = (claimed.body as { step_run: { id: string; lease_token: string } }).step_run;

    const before = await rig.pool.query<{ lease_expires_at: Date }>(
      `select lease_expires_at from step_runs where id = $1`,
      [stepRunId],
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    const heartbeat = await client.heartbeat(secret, {
      leases: [{ step_run_id: stepRun.id, lease_token: stepRun.lease_token }],
    });
    expect(heartbeat.status).toBe(200);
    const heartbeatBody = heartbeat.body as { cancel: string[]; unknown_leases: string[] };
    expect(heartbeatBody.cancel).toEqual([]);
    expect(heartbeatBody.unknown_leases).toEqual([]);

    const after = await rig.pool.query<{ lease_expires_at: Date }>(
      `select lease_expires_at from step_runs where id = $1`,
      [stepRunId],
    );
    expect(new Date(after.rows[0]!.lease_expires_at).getTime()).toBeGreaterThan(
      new Date(before.rows[0]!.lease_expires_at).getTime(),
    );
  });

  it("distinguishes unknown_leases (lost lease / reassigned) from cancel (operator cancelled) in the same heartbeat reply", async () => {
    const { secret, client } = await joinRunner(rig, ownerCookie);
    const ids = realIdGenerator();
    const { projectId, stepRunId: cancelledId } = await seedReadyStepRun(rig.pool, { stepKey: "to-be-cancelled" }, ids);
    const { stepRunId: staleId } = await seedReadyStepRun(rig.pool, { stepKey: "to-go-stale" }, ids);

    // Cancel is Project-`member`-gated (spec: "empat tombol tulis" — Cancel
    // is `member`). The break-glass account is org `owner` but not
    // automatically a member of a Project it didn't create through the
    // domain layer — self-add via the same escape hatch issue #3 built.
    await fetch(`${rig.baseUrl}/projects/${projectId}/members/self`, {
      method: "POST",
      headers: { cookie: ownerCookie, "x-factory-csrf": "1" },
    });

    const claimCancelled = await client.claim(secret, { tags: [] });
    const cancelledStepRun = (claimCancelled.body as { step_run: { id: string; lease_token: string } }).step_run;
    expect(cancelledStepRun.id).toBe(cancelledId);

    const claimStale = await client.claim(secret, { tags: [] });
    const staleStepRun = (claimStale.body as { step_run: { id: string; lease_token: string } }).step_run;
    expect(staleStepRun.id).toBe(staleId);

    // Operator cancels one — authoritative immediately.
    const cancelResponse = await fetch(`${rig.baseUrl}/step-runs/${cancelledId}/cancel`, {
      method: "POST",
      headers: { cookie: ownerCookie, "x-factory-csrf": "1" },
    });
    expect(cancelResponse.status).toBe(200);

    // The other's lease token goes stale by being overwritten — simulate
    // "lost lease" by presenting a token that no longer matches (as would
    // happen after a real sweep reassigned it).
    const bogusToken = "not-the-real-lease-token";

    const heartbeat = await client.heartbeat(secret, {
      leases: [
        { step_run_id: cancelledId, lease_token: cancelledStepRun.lease_token },
        { step_run_id: staleId, lease_token: bogusToken },
      ],
    });
    expect(heartbeat.status).toBe(200);
    const body = heartbeat.body as { cancel: string[]; unknown_leases: string[] };
    expect(body.cancel).toEqual([cancelledId]);
    expect(body.unknown_leases).toEqual([staleId]);
    // The two lists never share a member — an operator can always tell "someone cancelled this" from "you lost your lease".
    expect(body.cancel.some((id) => body.unknown_leases.includes(id))).toBe(false);
  });

  it("reschedules a StepRun whose lease expired as a new attempt, with reason recorded separately, once the sweep runs", async () => {
    const { secret, client } = await joinRunner(rig, ownerCookie);
    const { stepRunId } = await seedReadyStepRun(rig.pool);

    const claimed = await client.claim(secret);
    const stepRun = (claimed.body as { step_run: { attempt: number } }).step_run;
    expect(stepRun.attempt).toBe(1);

    // Force the lease into the past — standing in for "10s heartbeats
    // stopped arriving until the 30s lease window elapsed" without an
    // actual 30-second wait.
    await rig.pool.query(`update step_runs set lease_expires_at = now() - interval '1 second' where id = $1`, [
      stepRunId,
    ]);

    const { sweepExpiredLeases } = await import("../../src/domain/step-run-ops.js");
    const swept = await sweepExpiredLeases({ db: createDatabase(rig.pool) });
    expect(swept).toContain(stepRunId);

    const row = await rig.pool.query<{ outcome: string; attempt: number; reason: string | null; leased_by: string | null }>(
      `select outcome, attempt, reason, leased_by from step_runs where id = $1`,
      [stepRunId],
    );
    expect(row.rows[0]?.outcome).toBe("ready");
    expect(row.rows[0]?.attempt).toBe(2); // a new attempt, not a new row (spec: "attempt menghitung ulang ... retry menimpa baris yang sama").
    expect(row.rows[0]?.reason).toBe("lease-lost");
    expect(row.rows[0]?.leased_by).toBeNull();

    // Rescheduled — a different Runner can now claim it.
    const second = await joinRunner(rig, ownerCookie);
    const reclaim = await second.client.claim(second.secret);
    expect((reclaim.body as { step_run: { id: string; attempt: number } }).step_run?.id).toBe(stepRunId);
    expect((reclaim.body as { step_run: { id: string; attempt: number } }).step_run?.attempt).toBe(2);
  });

  it("runs the lease sweep before the HTTP listener opens at startup", async () => {
    const container: StartedPostgreSqlContainer = await new PostgreSqlContainer("postgres:16-alpine").start();
    const pool = new Pool({ connectionString: container.getConnectionUri() });
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });

    // Seed a StepRun with an already-expired lease directly, before the
    // control plane has ever opened a listener — nothing could have
    // expired it "live"; it starts already stale, the way a crash-and-
    // restart would leave one.
    const ids = testIdGenerator();
    const fixture = await seedRunFixture(pool, ids);
    const stepRunId = await seedStepRun(pool, ids, {
      runId: fixture.runId,
      repositoryId: fixture.repositoryId,
      outcome: "running",
      leasedBy: "runner-that-died",
      leaseExpiresAt: new Date(Date.now() - 60_000),
    });

    const deps: AppDeps = {
      db: createDatabase(pool),
      pool,
      clock: { now: () => new Date() },
      random: { bytes: (n: number) => new Uint8Array(n) },
      githubOAuth: createFakeGithubOAuthClient(),
      gitHost: createFakeGitHost(),
      claimHoldRangeMs: { min: 50, max: 100 },
      claimLimiter: createClaimConnectionLimiter(2000),
    };
    await bootstrapBreakGlassAccount(deps, "boot-sweep-test-password");

    // By the time this resolves, the sweep has already completed — the
    // control plane's own composition (`boot.ts`) awaits it before calling
    // `serve()`. If the implementation ever reordered that (fire-and-forget
    // the sweep, or ran it after opening the listener), this row would
    // still show `running` here, immediately after boot resolves, with no
    // request ever having been made against the server.
    const { server } = await bootControlPlane(deps, 0);

    try {
      const row = await pool.query<{ outcome: string }>(`select outcome from step_runs where id = $1`, [stepRunId]);
      expect(row.rows[0]?.outcome).toBe("ready");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await pool.end();
      await container.stop();
    }
  });
});
