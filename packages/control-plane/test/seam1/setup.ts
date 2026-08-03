/**
 * Seam-1 test rig (spec: "Testing Decisions" -> Seam 1). Boots a throwaway
 * Postgres container, runs the Drizzle migrations exactly as shipped, boots
 * the control plane with an injected clock and random source, and hands
 * back a base URL so tests can fire real HTTP at it. No mocks of the
 * control plane itself — a Runner-shaped test only needs to be an ordinary
 * HTTP client.
 */
import { serve, type ServerType } from "@hono/node-server";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { createApp } from "../../src/app.js";
import { createDatabase } from "../../src/db/client.js";
import { MIGRATIONS_FOLDER } from "../../src/db/migrations-path.js";
import type { AppDeps, Clock, RandomSource } from "../../src/deps.js";

export interface TestRig {
  baseUrl: string;
  pool: Pool;
  /** Moves the injected clock. No test in this rig ever reads the wall clock. */
  setClock(date: Date): void;
  stop(): Promise<void>;
}

/** Deterministic, seeded — never `crypto.getRandomValues`. Good enough for id uniqueness in tests. */
function seededRandom(seed: number): RandomSource {
  let state = seed;
  return {
    bytes: (length: number) => {
      const out = new Uint8Array(length);
      for (let i = 0; i < length; i++) {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        out[i] = state % 256;
      }
      return out;
    },
  };
}

export async function startTestRig(): Promise<TestRig> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    "postgres:16-alpine",
  ).start();

  const pool = new Pool({ connectionString: container.getConnectionUri() });
  await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });

  let currentTime = new Date("2026-01-01T00:00:00.000Z");
  const clock: Clock = { now: () => currentTime };

  const deps: AppDeps = {
    db: createDatabase(pool),
    clock,
    random: seededRandom(42),
  };

  const app = createApp(deps);

  const { server, port } = await new Promise<{ server: ServerType; port: number }>((resolve) => {
    const started = serve({ fetch: app.fetch, port: 0 }, (info) => {
      resolve({ server: started, port: info.port });
    });
  });

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    pool,
    setClock: (date: Date) => {
      currentTime = date;
    },
    async stop() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await pool.end();
      await container.stop();
    },
  };
}
