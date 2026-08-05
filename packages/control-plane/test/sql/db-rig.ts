/**
 * Rig shared by the three hand-written-SQL contract tests (spec: "Testing
 * Decisions" — "Tiga SQL tangan ... contract test langsung ke Postgres").
 * Unlike `test/seam1/setup.ts` this never boots the HTTP app: these tests
 * exercise `src/db/sql/*.sql` directly against a migrated Postgres, because
 * that's the boundary the spec draws — Drizzle isn't trusted for these
 * three, so the test shouldn't go through Drizzle's query builder either.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { generateId } from "@factory/shared";
import { Pool } from "pg";
import { MIGRATIONS_FOLDER } from "../../src/db/migrations-path.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SQL_DIR = path.resolve(here, "../../src/db/sql");

export interface SqlRig {
  pool: Pool;
  stop(): Promise<void>;
}

/**
 * Wipes every seedable table. The three SQL files under test here read and
 * write across the whole table with no project scoping (`claim_step_run`
 * claims the globally-oldest ready row; the retention sweeps scan the whole
 * `runs`/`step_runs` tables) — spec: "Testing Decisions", "setiap test harus
 * deterministic ... setiap test independen dari yang lain." One container is
 * reused per test file for startup cost; this is what keeps tests from
 * seeing each other's leftover rows instead.
 */
export async function resetDatabase(pool: Pool): Promise<void> {
  // webhook_deliveries has no FK to anything, so it must be named explicitly
  // — everything else under test cascades from runs/step_runs.
  await pool.query(
    `truncate table runs, step_runs, projects, repositories, github_app_installations, principals, audit_log, webhook_deliveries restart identity cascade`,
  );
}

export async function startSqlRig(): Promise<SqlRig> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    "postgres:16-alpine",
  ).start();
  const pool = new Pool({ connectionString: container.getConnectionUri() });
  await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });

  return {
    pool,
    async stop() {
      await pool.end();
      await container.stop();
    },
  };
}

/**
 * Reads one of the three hand-written `.sql` files and strips full-line
 * comments, returning the bare statement(s) — the same text a caller would
 * send over the wire, without the prose that documents it.
 */
export function loadSqlStatements(fileName: string): string[] {
  const raw = readFileSync(path.join(SQL_DIR, fileName), "utf-8");
  const withoutComments = raw
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  return withoutComments
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/** Deterministic id generator — a counter stands in for both clock and randomness. */
export function testIdGenerator() {
  let counter = 0;
  return {
    next<P extends Parameters<typeof generateId>[0]>(prefix: P) {
      counter += 1;
      const c = counter;
      return generateId(prefix, {
        now: () => 1_700_000_000_000 + c,
        randomBytes: (length: number) => {
          const bytes = new Uint8Array(length);
          for (let i = 0; i < length; i++) {
            bytes[i] = (c * 7 + i * 13) % 256;
          }
          return bytes;
        },
      });
    },
  };
}
