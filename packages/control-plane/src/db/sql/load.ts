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
  return splitStatements(readFileSync(path.join(here, fileName), "utf-8")).map((entry) => entry.sql);
}

/**
 * The same file, keyed by the `-- name: <identifier>` marker that precedes
 * each statement. Positional reads of a multi-statement file are the hazard
 * this closes: ten statements destructured by position stay type-correct and
 * count-correct after someone reorders the file, and the mismatch only shows
 * up as a sweep marking the wrong table. A name has to be moved deliberately.
 *
 * Every statement in a named file must carry a marker, and no name may repeat
 * — both are load-time errors, so a half-labelled file fails at import rather
 * than at the first sweep.
 */
export function loadNamedSqlStatements(fileName: string): Record<string, string> {
  const entries = splitStatements(readFileSync(path.join(here, fileName), "utf-8"));
  const named: Record<string, string> = {};
  for (const [index, entry] of entries.entries()) {
    if (entry.name === undefined) {
      throw new Error(`${fileName}: statement ${index + 1} has no '-- name:' marker`);
    }
    if (named[entry.name] !== undefined) {
      throw new Error(`${fileName}: duplicate statement name '${entry.name}'`);
    }
    named[entry.name] = entry.sql;
  }
  return named;
}

const NAME_MARKER = /^--\s*name:\s*(\S+)\s*$/;

/**
 * Strips full-line `--` comments and splits the remainder on `;`, carrying
 * each statement's `-- name:` marker out with it.
 *
 * Comments are removed *before* the split, never after: the prose in these
 * files contains semicolons of its own, so splitting first would shred the
 * file into fragments that no longer parse as SQL.
 */
function splitStatements(raw: string): { name?: string; sql: string }[] {
  const statements: { name?: string; sql: string }[] = [];
  let pendingName: string | undefined;
  let buffer: string[] = [];

  const flush = (): void => {
    const sql = buffer.join("\n").trim();
    buffer = [];
    if (sql.length === 0) return;
    statements.push({ ...(pendingName === undefined ? {} : { name: pendingName }), sql });
    pendingName = undefined;
  };

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    const marker = NAME_MARKER.exec(trimmed);
    if (marker?.[1] !== undefined) {
      pendingName = marker[1];
      continue;
    }
    if (trimmed.startsWith("--")) continue;

    const parts = line.split(";");
    for (const part of parts.slice(0, -1)) {
      buffer.push(part);
      flush();
    }
    buffer.push(parts[parts.length - 1] ?? "");
  }
  flush();

  return statements;
}
