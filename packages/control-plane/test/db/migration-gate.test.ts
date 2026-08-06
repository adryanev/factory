/**
 * Contract test for the boot-time migration gate, against a real Postgres —
 * acceptance criterion: "control plane menolak start dengan pesan jelas
 * bila skema tidak cocok" (control plane refuses to start with a clear
 * message when the schema doesn't match).
 */
import { type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertMigrationsApplied, MigrationGateError } from "../../src/db/migration-gate.js";
import { MIGRATIONS_FOLDER } from "../../src/db/migrations-path.js";
import { startPostgresContainer } from "../postgres-container.js";

describe("assertMigrationsApplied", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  beforeAll(async () => {
    container = await startPostgresContainer();
    pool = new Pool({ connectionString: container.getConnectionUri() });
  });

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  it("refuses to start when no migrations have been applied", async () => {
    await expect(assertMigrationsApplied(pool, MIGRATIONS_FOLDER)).rejects.toThrow(
      MigrationGateError,
    );
  });

  it("passes once the shipped migrations have been applied, as-is", async () => {
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });

    await expect(assertMigrationsApplied(pool, MIGRATIONS_FOLDER)).resolves.toBeUndefined();
  });

  it("refuses to start when the applied migration hash no longer matches the shipped file", async () => {
    await pool.query(`update drizzle.__drizzle_migrations set hash = 'tampered'`);

    await expect(assertMigrationsApplied(pool, MIGRATIONS_FOLDER)).rejects.toThrow(
      /does not match what's applied/,
    );
  });
});
