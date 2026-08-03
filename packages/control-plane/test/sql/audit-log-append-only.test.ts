/**
 * Contract test for `src/db/sql/audit_log_append_only.sql` (shipped as
 * migration `drizzle/0002_audit_log_append_only_trigger.sql`). What this
 * genuinely proves: the append-only guarantee lives in Postgres itself, not
 * in application discipline — even a raw `UPDATE`/`DELETE` issued straight
 * over the connection, bypassing every layer of app code, is rejected.
 * What it does NOT prove: that no Postgres role can ever bypass it (the
 * table owner / a superuser still can — spec: "audit_log append-only
 * ditegakkan lewat trigger di level DB, bukan REVOKE" accepts that trade
 * explicitly, trigger over REVOKE only because it ships for free in every
 * migration).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "../../src/db/client.js";
import { auditLog, principals } from "../../src/db/schema.js";
import { startSqlRig, testIdGenerator, type SqlRig } from "./db-rig.js";

describe("audit_log append-only trigger", () => {
  let rig: SqlRig;
  const ids = testIdGenerator();

  beforeAll(async () => {
    rig = await startSqlRig();
  });

  afterAll(async () => {
    await rig.stop();
  });

  async function seedOneAuditRow() {
    const db = createDatabase(rig.pool);
    const actorId = ids.next("user");
    await db.insert(principals).values({ id: actorId, kind: "user" });
    const rowId = ids.next("audit");
    await db.insert(auditLog).values({
      id: rowId,
      actorPrincipalId: actorId,
      action: "project.member_added",
    });
    return rowId;
  }

  it("allows a plain INSERT", async () => {
    await expect(seedOneAuditRow()).resolves.toBeTruthy();
  });

  it("rejects UPDATE with a loud exception, not a silent no-op", async () => {
    const rowId = await seedOneAuditRow();

    await expect(
      rig.pool.query(`update audit_log set action = 'tampered' where id = $1`, [rowId]),
    ).rejects.toThrow(/append-only/);

    const { rows } = await rig.pool.query<{ action: string }>(
      `select action from audit_log where id = $1`,
      [rowId],
    );
    expect(rows[0]?.action).toBe("project.member_added");
  });

  it("rejects DELETE with a loud exception, not a silent no-op", async () => {
    const rowId = await seedOneAuditRow();

    await expect(rig.pool.query(`delete from audit_log where id = $1`, [rowId])).rejects.toThrow(
      /append-only/,
    );

    const { rows } = await rig.pool.query(`select 1 from audit_log where id = $1`, [rowId]);
    expect(rows).toHaveLength(1);
  });

  it("names the operation and table in the exception, for an operator reading the log", async () => {
    const rowId = await seedOneAuditRow();

    await expect(
      rig.pool.query(`update audit_log set action = 'x' where id = $1`, [rowId]),
    ).rejects.toThrow(/UPDATE on audit_log/);
  });
});
