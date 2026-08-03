-- Shipped as migration drizzle/0002_audit_log_append_only_trigger.sql — this
-- copy is the documented, commented source of truth; keep the two in sync by
-- hand (drizzle-kit's migration-gate hash only covers the migrations
-- folder, so this file alone is never applied to a database).
--
-- Ditulis tangan, bukan Drizzle: audit_log harus append-only DI LEVEL DB,
-- bukan disiplin aplikasi (spec: "saya ingin catatan audit yang tidak bisa
-- diubah atau dihapus"; "audit_log append-only ditegakkan lewat trigger di
-- level DB, bukan REVOKE").
--
-- Kenapa trigger, bukan REVOKE UPDATE/DELETE dari role aplikasi: keduanya
-- sama kuat (pemilik tabel bisa melewati keduanya), tapi trigger ikut di
-- dalam migrasi, jadi setiap instalasi mendapatkannya tanpa satu langkah
-- operator pun. REVOKE menuntut role DB terpisah, connection string
-- terpisah, dan satu langkah pembuatan role di packaging — yang kalau
-- terlewat, jaminannya hilang TANPA SUARA (issue 25-database-schema.md,
-- bagian "Append-only").
--
-- Kenapa RAISE EXCEPTION, bukan `CREATE RULE ... DO INSTEAD NOTHING`: RULE
-- menelan pelanggaran tanpa suara (UPDATE/DELETE "berhasil" tapi tidak
-- terjadi apa-apa); RAISE membuatnya berisik. Biaya runtime nol: trigger
-- hanya menyala pada UPDATE/DELETE yang secara sah tidak pernah terjadi.

CREATE OR REPLACE FUNCTION audit_log_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % on % is forbidden (row id=%)',
    TG_OP, TG_TABLE_NAME, COALESCE(OLD.id, 'unknown');
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_append_only ON audit_log;

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW
  EXECUTE FUNCTION audit_log_forbid_mutation();
