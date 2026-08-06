/**
 * The package's single way to boot a throwaway Postgres container for the
 * test rigs. The one shared readiness budget keeps every container wait
 * coherent (issue #31): the library's health-check retries run for roughly
 * 250s (250ms interval, 1000 retries), so the condition-based readiness
 * wait is capped at 240s — comfortably inside the library's own retry
 * horizon, and long enough that a loaded machine (the four package suites
 * plus parallel CI) is not misread as a broken container.
 */
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";

export const CONTAINER_READY_BUDGET_MS = 240_000;

export async function startPostgresContainer(): Promise<StartedPostgreSqlContainer> {
  return await new PostgreSqlContainer("postgres:16-alpine")
    .withStartupTimeout(CONTAINER_READY_BUDGET_MS)
    .start();
}

/**
 * The rigs' one pool factory. node-postgres requires a pool-level error
 * listener: without one, a connection-level error outside a query crashes
 * the process (unhandled 'error'). In the rigs that error is routine — the
 * container is killed by `container.stop()` while `pool.end()` is still
 * closing clients, and the dying server sends 57P01 into the closing
 * handshake. Query-level failures still surface through the awaited query
 * promises; the listener only absorbs the expected teardown noise.
 */
export function createTestPool(connectionString: string): Pool {
  const pool = new Pool({ connectionString });
  pool.on("error", () => {});
  return pool;
}
