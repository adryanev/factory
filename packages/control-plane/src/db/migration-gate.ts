/**
 * Boot-time migration gate.
 *
 * The control plane never applies migrations itself (`migrate.ts` is a
 * separate one-shot process — see spec "Packaging self-host"). What it does
 * on every boot is refuse to serve traffic when the migrations applied to
 * the database don't match the migration files it ships, so "forgot to
 * migrate" is a loud, immediate startup failure instead of a 500 discovered
 * hours later on whichever endpoint happens to touch the missing column.
 *
 * This reads the exact table drizzle-orm's own migrator writes to
 * (`drizzle.__drizzle_migrations`, one row per applied migration with a
 * sha256 hash of that migration's `.sql` file) and compares it against the
 * migration files on disk, hashed the same way. See
 * `drizzle-orm/migrator.js` (`readMigrationFiles`) and
 * `drizzle-orm/pg-core/dialect.js` (`PgDialect.migrate`) for the format this
 * mirrors.
 */
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import type { Pool } from "pg";

interface JournalEntry {
  tag: string;
  when: number;
}

interface Journal {
  entries: JournalEntry[];
}

interface ExpectedMigration {
  tag: string;
  hash: string;
}

export class MigrationGateError extends Error {
  override readonly name = "MigrationGateError";
}

function readExpectedMigrations(migrationsFolder: string): ExpectedMigration[] {
  const journalPath = `${migrationsFolder}/meta/_journal.json`;
  if (!existsSync(journalPath)) {
    throw new MigrationGateError(
      `Migration gate: no journal at ${journalPath}. This control plane build ships no migrations to verify — check MIGRATIONS_FOLDER.`,
    );
  }
  const journal = JSON.parse(readFileSync(journalPath, "utf-8")) as Journal;
  return [...journal.entries]
    .sort((a, b) => a.when - b.when)
    .map((entry) => {
      const sql = readFileSync(`${migrationsFolder}/${entry.tag}.sql`, "utf-8");
      return { tag: entry.tag, hash: createHash("sha256").update(sql).digest("hex") };
    });
}

function isUndefinedTableError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "42P01"
  );
}

async function readAppliedHashes(pool: Pool): Promise<string[]> {
  try {
    const result = await pool.query<{ hash: string }>(
      `select hash from drizzle.__drizzle_migrations order by created_at asc`,
    );
    return result.rows.map((row) => row.hash);
  } catch (error) {
    if (isUndefinedTableError(error)) {
      return [];
    }
    throw error;
  }
}

const MIGRATE_COMMAND = "pnpm --filter @factory/control-plane run db:migrate";

/**
 * Throws {@link MigrationGateError} with an operator-actionable message when
 * the database's applied migrations don't exactly match, in order, the
 * migration files shipped in `migrationsFolder`. Resolves silently when they
 * match. Call once at boot, before opening the HTTP listener.
 */
export async function assertMigrationsApplied(
  pool: Pool,
  migrationsFolder: string,
): Promise<void> {
  const expected = readExpectedMigrations(migrationsFolder);
  const applied = await readAppliedHashes(pool);

  if (applied.length === 0 && expected.length > 0) {
    throw new MigrationGateError(
      `Migration gate: database has no migrations applied, but this build ships ${expected.length}. Run \`${MIGRATE_COMMAND}\` before starting the control plane.`,
    );
  }

  if (applied.length !== expected.length) {
    throw new MigrationGateError(
      `Migration gate: ${expected.length} migration(s) shipped but ${applied.length} applied to the database. Run \`${MIGRATE_COMMAND}\` to reconcile, or confirm you're pointed at the right database.`,
    );
  }

  for (const [i, expectedMigration] of expected.entries()) {
    if (expectedMigration.hash !== applied[i]) {
      throw new MigrationGateError(
        `Migration gate: migration "${expectedMigration.tag}" (position ${i}) does not match what's applied to the database. The migration files on disk have diverged from what this database ran — refusing to start against a schema this build doesn't recognize.`,
      );
    }
  }
}
