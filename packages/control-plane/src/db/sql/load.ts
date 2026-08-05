/**
 * Runtime loader for the hand-written `.sql` files next to this one —
 * `claim_step_run.sql` is the only caller today (`domain/step-run-claim.ts`).
 * Mirrors `test/sql/db-rig.ts`'s `loadSqlStatements` (comment-stripping,
 * same directory) on purpose: the contract test and the production code path
 * must read the identical file, or a passing contract test would prove
 * nothing about what actually runs.
 *
 * Ships to `dist/db/sql/*.sql` alongside the compiled `.js` via the
 * `build` script's explicit copy step — `tsc` does not copy non-TypeScript
 * files on its own.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Strips full-line `--` comments and trailing whitespace; the file must contain exactly one statement (enforced by the caller, same as the contract test). */
export function loadSqlStatement(fileName: string): string {
  const raw = readFileSync(path.join(here, fileName), "utf-8");
  const withoutComments = raw
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .trim();
  return withoutComments.endsWith(";") ? withoutComments.slice(0, -1) : withoutComments;
}

/**
 * Strips full-line `--` comments and splits on `;`, returning the bare
 * statements — the same text a caller would send over the wire, without the
 * prose that documents them. The exact mirror of `test/sql/db-rig.ts`'s
 * `loadSqlStatements`, so `retention_sweeps.sql`'s SELECT/UPDATE pairs are
 * read identically by the contract test and by `domain/retention-sweeps.ts`.
 */
export function loadSqlStatements(fileName: string): string[] {
  const raw = readFileSync(path.join(here, fileName), "utf-8");
  const withoutComments = raw
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  return withoutComments
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}
