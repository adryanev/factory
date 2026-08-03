#!/usr/bin/env sh
# Placeholder for #21's real `factory migrate` command (Drizzle migrate() wrapped in
# pg_advisory_lock, plus the boot-time schema-hash gate control-plane checks before
# serving -- see spec "Packaging self-host" and issue #21). This script exists to
# prove the *shape* now, before the control-plane image does: one-shot service,
# depends_on: { condition: service_completed_successfully } from whatever depends on
# a migrated schema, and an advisory lock held even though compose already guarantees
# a single caller -- because an operator running this by hand alongside `compose up`
# is exactly the case the design doc calls out (Drizzle's migrate() itself takes no
# lock, confirmed against pg-core/dialect.ts by the design doc this mirrors).
set -eu

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
SELECT pg_advisory_lock(727215);

CREATE TABLE IF NOT EXISTS schema_migrations_placeholder (
  id integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO schema_migrations_placeholder (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

SELECT pg_advisory_unlock(727215);
SQL

echo "migrate: placeholder migration applied (one-shot, advisory-locked) -- #21 replaces this with the real Drizzle runner"
