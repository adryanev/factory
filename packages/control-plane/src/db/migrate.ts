/**
 * One-shot migration runner. In self-host packaging this is its own compose
 * service that exits before the control plane starts (spec: "Packaging
 * self-host") — the control plane itself never applies migrations, it only
 * gates on them (see `migration-gate.ts`).
 *
 * The advisory lock is the second half of "exactly one migrator" (spec
 * decision 2, issue 28): compose's `service_completed_successfully` makes a
 * single caller *by construction*, but that guarantee only covers
 * `compose up`. An operator running this command by hand while compose is
 * up is a second caller the compose file cannot see — so this runner takes
 * `pg_advisory_lock` **before** `migrate()` and releases it **after**.
 * Drizzle's `migrate()` itself takes no lock (verified against
 * `drizzle-orm/pg-core/dialect.ts`): two racing callers both read "nothing
 * applied yet", one wins and the other dies on `relation already exists`
 * without the lock. The lock turns that second caller into a no-op instead:
 * it blocks until the first commits, then reads the journal again and has
 * nothing left to apply.
 *
 * The lock key is a fixed constant shared with nothing else in the system —
 * a 64-bit space keyed by this application's intent, not a content hash.
 * Held for the whole `migrate()` call, released in `finally` so a failed
 * migration never leaks the lock (a leaked lock would stall the next
 * hand-run operator forever).
 */
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import { MIGRATIONS_FOLDER } from "./migrations-path.js";

/** Fixed advisory-lock key for the migration runner. */
export const MIGRATION_ADVISORY_LOCK_KEY = 727215;

/** Runs Drizzle's `migrate()` while holding the advisory lock. Safe to call concurrently — the loser becomes a no-op. */
export async function runMigrations(pool: Pool, migrationsFolder: string): Promise<void> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [MIGRATION_ADVISORY_LOCK_KEY]);
    await migrate(drizzle(client), { migrationsFolder });
  } finally {
    await client.query("select pg_advisory_unlock($1)", [MIGRATION_ADVISORY_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

async function main(): Promise<void> {
  const connectionString = process.env["DATABASE_URL"];
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to run migrations");
  }

  const pool = new Pool({ connectionString });
  try {
    await runMigrations(pool, MIGRATIONS_FOLDER);
    console.log("migrations applied");
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
