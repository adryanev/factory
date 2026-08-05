#!/usr/bin/env sh
# factory-backup — the backup procedure (spec "Packaging self-host",
# decision 4). Two targets, two correct mechanisms, one file that is kept
# out BY LAYOUT, not by a warning:
#
#   - Postgres: pg_dump into the running postgres container, streamed out.
#     A consistent transactional dump — never a copy of the data directory
#     of a live server (that is a snapshot nobody can promise is
#     consistent).
#   - Garage: S3 object sync to a destination. Copying a live service's
#     data directories is refused here for the same reason as Postgres;
#     object-level sync is safe specifically because Artifacts are
#     immutable (spec ticket 15) and log objects are never rewritten after
#     they finish (ticket 18). An object being written mid-run is missed —
#     that is a half-finished log of a Run still in flight, a loss that is
#     correct to accept.
#   - The master key at ./deploy/keys/master.key is NOT in this backup,
#     and no invocation of this script can put it there: ./deploy/keys is a
#     bind-mounted host directory outside every volume this script touches
#     (postgres-data, garage-data) and outside its own output root. The
#     guard below is a tripwire, not the enforcement — the layout is the
#     enforcement, exactly per spec decision 4 ("ditegakkan lewat tata
#     letak, bukan lewat peringatan").
#
# Usage: deploy/backup/backup.sh [destination-dir]
#   default destination: ./backups (gitignored)
# Requires: docker compose (run from the repo root), aws CLI credentials
# via BACKUP_S3_ENDPOINT + BACKUP_S3_TARGET (an S3-compatible bucket/prefix)
# or no environment for a local destination.
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
BACKUP_DIR="${1:-$ROOT_DIR/backups}"
MASTER_KEY_FILE="$ROOT_DIR/deploy/keys/master.key"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

mkdir -p "$BACKUP_DIR"

# Tripwire: the layout is the enforcement, but if the operator ever moves
# the key INTO the backup root, fail before the dump lands next to it.
backup_abs="$(cd "$BACKUP_DIR" && pwd)"
key_abs="$(cd "$(dirname "$MASTER_KEY_FILE")" && pwd)/$(basename "$MASTER_KEY_FILE")"
case "$key_abs" in
  "$backup_abs"/*)
    echo "backup: refusing — the master key lives under $BACKUP_DIR. Move it back to deploy/keys/; the layout is what keeps it out of backups." >&2
    exit 1
    ;;
esac

echo "backup: dumping Postgres (transactional pg_dump)..."
# -T: no TTY, so the stream is clean. The dump is written straight to disk,
# never staged inside the container.
docker compose exec -T postgres pg_dump -U "${POSTGRES_USER:-factory}" -d "${POSTGRES_DB:-factory}" \
  > "$BACKUP_DIR/factory-pg-$STAMP.sql"
echo "backup: wrote $BACKUP_DIR/factory-pg-$STAMP.sql"

if [ -n "${BACKUP_S3_ENDPOINT:-}" ] && [ -n "${BACKUP_S3_TARGET:-}" ]; then
  echo "backup: syncing Garage objects to $BACKUP_S3_TARGET ..."
  # Object-level sync via the S3 API (same aws-cli image the compose stack
  # uses for garage-init). The endpoint may be a second Garage, an S3
  # bucket, or anything S3-compatible — RPO is an operator policy.
  docker run --rm \
    -e "AWS_ACCESS_KEY_ID=${BACKUP_S3_ACCESS_KEY:?BACKUP_S3_ACCESS_KEY required for remote target}" \
    -e "AWS_SECRET_ACCESS_KEY=${BACKUP_S3_SECRET_KEY:?BACKUP_S3_SECRET_KEY required for remote target}" \
    -e "AWS_DEFAULT_REGION=${BACKUP_S3_REGION:-garage}" \
    amazon/aws-cli:2.31.13 s3 sync "s3://factory" "$BACKUP_S3_TARGET" \
      --endpoint-url "$BACKUP_S3_ENDPOINT" \
      --no-follow-symlinks
  echo "backup: Garage objects synced."
else
  echo "backup: BACKUP_S3_ENDPOINT/BACKUP_S3_TARGET unset — skipping the object sync."
  echo "  Set them to back up Garage objects (s3 sync to any S3-compatible target)."
fi

echo ""
echo "backup: done. Restore = load the dump, then s3 sync back — see docs/operating.md."
echo "  The master key was NOT backed up (it lives outside the backup layout)."
echo "  Losing it means re-entering every user secret — historical runs, cost rows,"
echo "  and the audit log all stay readable, because none of those is encrypted."
