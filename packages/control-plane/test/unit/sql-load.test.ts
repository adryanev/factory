/**
 * The `.sql` loader. `loadNamedSqlStatements` is what stops a reordered
 * multi-statement file from silently re-pairing the retention sweeps, so the
 * marker parsing itself needs proving — against the real files, since a
 * fixture would let the convention drift away from what ships.
 */
import { describe, expect, it } from "vitest";
import { loadNamedSqlStatements, loadSqlStatements } from "../../src/db/sql/load.js";

describe("loadNamedSqlStatements", () => {
  it("keys retention_sweeps.sql by its markers, and every name is a distinct statement", () => {
    const statements = loadNamedSqlStatements("retention_sweeps.sql");

    expect(Object.keys(statements).sort()).toEqual([
      "artifact_candidate",
      "artifact_mark",
      "branch_candidate",
      "branch_mark",
      "log_candidate",
      "log_mark",
      "session_candidate",
      "session_mark",
      "webhook_candidate",
      "webhook_mark",
    ]);
    expect(new Set(Object.values(statements)).size).toBe(10);
  });

  it("pairs each sweep's SELECT with the UPDATE that writes its own marker column", () => {
    const statements = loadNamedSqlStatements("retention_sweeps.sql");

    // The mis-pairing the names exist to prevent: a marker column named in the
    // SELECT must be the column the matching UPDATE sets.
    for (const [prefix, column] of [
      ["artifact", "artifacts_purged_at"],
      ["log", "logs_purged_at"],
      ["branch", "branches_purged_at"],
      ["session", "session_purged_at"],
      ["webhook", "purged_at"],
    ] as const) {
      expect(statements[`${prefix}_candidate`]).toContain(`${column} IS NULL`);
      expect(statements[`${prefix}_mark`]).toContain(`SET ${column} = now()`);
    }
  });

  it("strips the prose but keeps the statement body intact", () => {
    const statements = loadNamedSqlStatements("retention_sweeps.sql");

    expect(statements["artifact_candidate"]).not.toContain("--");
    expect(statements["artifact_candidate"]).toContain("FOR UPDATE SKIP LOCKED");
    expect(statements["artifact_candidate"]?.startsWith("SELECT")).toBe(true);
    // The trailing `;` is the split point, so no statement carries one.
    expect(statements["artifact_mark"]?.endsWith(";")).toBe(false);
  });

  it("agrees with the positional loader on the same file — the two must read one text", () => {
    const positional = loadSqlStatements("retention_sweeps.sql");
    const named = loadNamedSqlStatements("retention_sweeps.sql");

    expect(positional).toHaveLength(10);
    expect(new Set(positional)).toEqual(new Set(Object.values(named)));
  });

  it("refuses a file whose statements are not all named", () => {
    // claim_step_run.sql carries no markers; asking for names must fail loudly
    // rather than return a partial map that a caller would read as complete.
    expect(() => loadNamedSqlStatements("claim_step_run.sql")).toThrow(/no '-- name:' marker/);
  });
});
