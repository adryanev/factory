-- Hand-written, not drizzle-kit generated. Canonical source and rationale:
-- src/db/sql/audit_log_append_only.sql — keep the two in sync by hand; this
-- file is what actually ships (drizzle-kit's migration-gate hash covers
-- migration files on disk, not src/db/sql/).

CREATE OR REPLACE FUNCTION audit_log_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % on % is forbidden (row id=%)',
    TG_OP, TG_TABLE_NAME, COALESCE(OLD.id, 'unknown');
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS audit_log_append_only ON audit_log;
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW
  EXECUTE FUNCTION audit_log_forbid_mutation();
