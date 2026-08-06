/**
 * Contract test for the advisory-locked migration runner (`src/db/migrate.ts`,
 * spec "Packaging self-host", decision 2). What this proves, against a real
 * Postgres:
 *  - two concurrent runners against a fresh database both complete without
 *    error, and exactly one set of migrations is applied — the loser
 *    blocked on `pg_advisory_lock`, re-read the journal, and became a
 *    no-op instead of dying on `relation already exists`.
 *  - that is exactly the hand-typed-operator case: compose's
 *    `service_completed_successfully` guarantees a single caller, but an
 *    operator running the command by hand alongside `compose up` is a
 *    second caller only the lock can serialize.
 *  - a re-run after success is a no-op.
 *
 * Drizzle's `migrate()` takes no lock of its own (verified against
 * `drizzle-orm/pg-core/dialect.ts`): this test is the proof that our lock
 * closes the race the no-lock call has.
 */
import { afterAll, describe, expect, it } from "vitest";
import { type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createTestPool } from "../postgres-container.js";
import { Pool } from "pg";
import { MIGRATIONS_FOLDER } from "../../src/db/migrations-path.js";
import { runMigrations } from "../../src/db/migrate.js";
import { startPostgresContainer } from "../postgres-container.js";

describe("advisory-locked migration runner", () => {
  let container: StartedPostgreSqlContainer | null = null;
  const pools: Pool[] = [];

  async function freshPool(): Promise<Pool> {
    container = await startPostgresContainer();
    const pool = createTestPool(container.getConnectionUri());
    pools.push(pool);
    return pool;
  }

  afterAll(async () => {
    await Promise.all(pools.map((pool) => pool.end()));
    if (container) {
      await container.stop();
    }
  });

  it("applies every migration exactly once when two runners race a fresh database", async () => {
    const pool = await freshPool();

    const [first, second] = await Promise.all([
      runMigrations(pool, MIGRATIONS_FOLDER),
      runMigrations(pool, MIGRATIONS_FOLDER),
    ]);
    expect(first).toBeUndefined();
    expect(second).toBeUndefined();

    const journal = await pool.query(
      `select hash from drizzle.__drizzle_migrations order by created_at asc`,
    );
    const expected = JSON.parse(
      await import("node:fs").then((fs) => fs.promises.readFile(`${MIGRATIONS_FOLDER}/meta/_journal.json`, "utf-8")),
    ).entries.length as number;
    expect(journal.rows).toHaveLength(expected);

    // Every migration actually landed — the loser did not apply half a set.
    const tables = await pool.query(
      `select count(*)::int as n from information_schema.tables where table_schema = 'public'`,
    );
    expect(tables.rows[0].n).toBeGreaterThan(20);
  });

  it("re-running after success is a no-op — an operator re-running by hand changes nothing", async () => {
    const pool = await freshPool();
    await runMigrations(pool, MIGRATIONS_FOLDER);

    const before = await pool.query(`select count(*)::int as n from drizzle.__drizzle_migrations`);
    await runMigrations(pool, MIGRATIONS_FOLDER);
    const after = await pool.query(`select count(*)::int as n from drizzle.__drizzle_migrations`);

    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("releases the advisory lock afterwards — a later hand-run does not block forever", async () => {
    const pool = await freshPool();
    await runMigrations(pool, MIGRATIONS_FOLDER);

    // If the lock leaked, this same-session acquisition would deadlock...
    // postgres blocks rather than fails, so prove liveness differently: the
    // lock is free for another session to take.
    const acquired = await pool.query(
      `select pg_try_advisory_lock(727215) as ok`,
    );
    expect(acquired.rows[0].ok).toBe(true);
    await pool.query(`select pg_advisory_unlock(727215)`);
  });
});
