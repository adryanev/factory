/**
 * Real-process composition root. Reads infrastructure config (connection
 * string, port) from the environment — that's ambient authentication-free
 * config, not the clock/network/random-seed inputs `deps.ts` documents as
 * injected. Everything downstream of this file receives its dependencies
 * explicitly.
 */
import { serve } from "@hono/node-server";
import { Pool } from "pg";
import { createApp } from "./app.js";
import { createDeps } from "./deps.js";
import { assertMigrationsApplied, MigrationGateError } from "./db/migration-gate.js";
import { MIGRATIONS_FOLDER } from "./db/migrations-path.js";

async function main(): Promise<void> {
  const connectionString = process.env["DATABASE_URL"];
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }
  const port = Number(process.env["PORT"] ?? 3000);

  const pool = new Pool({ connectionString });

  try {
    await assertMigrationsApplied(pool, MIGRATIONS_FOLDER);
  } catch (error) {
    if (error instanceof MigrationGateError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const app = createApp(createDeps(pool));
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`control plane listening on http://localhost:${info.port}`);
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
