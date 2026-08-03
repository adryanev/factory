/**
 * One-shot migration runner. In self-host packaging this is its own compose
 * service that exits before the control plane starts (spec: "Packaging
 * self-host") — the control plane itself never applies migrations, it only
 * gates on them (see `migration-gate.ts`).
 */
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { MIGRATIONS_FOLDER } from "./migrations-path.js";

async function main(): Promise<void> {
  const connectionString = process.env["DATABASE_URL"];
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to run migrations");
  }

  const pool = new Pool({ connectionString });
  try {
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    console.log("migrations applied");
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
