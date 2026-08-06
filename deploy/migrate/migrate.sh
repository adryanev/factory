#!/usr/bin/env sh
# The real migration runner (issue #21) — replaces the #18/#19 placeholder.
# Entrypoint for the one-shot `migrate` compose service, and the command an
# operator types by hand against the running stack:
#
#   docker compose run --rm migrate
#
# What runs is the control-plane image's bundled Drizzle runner
# (dist/migrate.bundle.mjs, built from src/db/migrate.ts). That runner:
#
#   1. takes pg_advisory_lock(727215) BEFORE migrate() — compose's
#      service_completed_successfully guarantees one caller per compose-up,
#      but an operator typing this by hand while compose is up is a second
#      caller only the lock can serialize. The loser blocks, re-reads the
#      journal after the winner commits, and becomes a no-op instead of
#      dying on `relation already exists` (Drizzle's migrate() itself takes
#      no lock — verified against pg-core/dialect.ts, and contract-tested
#      in packages/control-plane/test/sql/migrate-lock.test.ts).
#   2. releases the lock in `finally`, so a failed migration never leaks it.
#   3. fails loudly (exit 1) on any error — the control-plane service is
#      held down by service_completed_successfully, so a broken migration
#      shows as a red container, not as a half-applied schema.
#
# The control plane additionally gates at boot on the applied-hashes
# matching the files this image ships (src/db/migration-gate.ts).
set -eu

if [ -z "${DATABASE_URL:-}" ]; then
  echo "migrate: DATABASE_URL is required (the compose service sets it)" >&2
  exit 1
fi

exec node /app/dist/db/migrate.bundle.mjs
