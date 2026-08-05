#!/usr/bin/env sh
# factory-init — first-install secret generation (spec "Packaging self-host",
# decision 8). Generates every local secret with a real source of randomness
# and writes it to the two places the config split assigns it:
#
#   deploy/keys/master.key            key material -> FILE (0600)
#   deploy/keys/github-app-private-key.pem   (written later by register-app.sh)
#   .env (repo root)                  service passwords -> ENVIRONMENT
#
# Nol nilai default yang dikirim: nothing here is a `changeme`, nothing is
# printed except the break-glass password, which is printed exactly once to
# stdout because it is the only value a human must remember before the
# GitHub login path exists.
#
# Idempotent by refusal: existing key files are never overwritten, so a
# re-run cannot silently rotate a master key that encrypts real secrets.
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
KEYS_DIR="$ROOT_DIR/deploy/keys"
ENV_FILE="$ROOT_DIR/.env"
MASTER_KEY_FILE="$KEYS_DIR/master.key"

mkdir -p "$KEYS_DIR"
chmod 700 "$KEYS_DIR"

if [ -f "$MASTER_KEY_FILE" ]; then
  echo "factory-init: $MASTER_KEY_FILE already exists — refusing to overwrite key material." >&2
  exit 1
fi

if [ -f "$ENV_FILE" ]; then
  echo "factory-init: $ENV_FILE already exists — refusing to overwrite. Delete it and re-run if this is a fresh install." >&2
  exit 1
fi

# Master key: 32 bytes hex, wrapped in the JSON envelope createFileKeyRing
# reads (domain/master-key.ts: {"currentVersion":1,"keys":{"1":"<64 hex>"}}).
umask 077
MASTER_KEY_HEX="$(openssl rand -hex 32)"
printf '{"currentVersion":1,"keys":{"1":"%s"}}\n' "$MASTER_KEY_HEX" > "$MASTER_KEY_FILE"
chmod 600 "$MASTER_KEY_FILE"

POSTGRES_PASSWORD="$(openssl rand -base64 24)"
GARAGE_RPC_SECRET="$(openssl rand -hex 32)"
GARAGE_ACCESS_KEY="$(openssl rand -hex 16)"
GARAGE_SECRET_KEY="$(openssl rand -base64 32)"
BREAK_GLASS_PASSWORD="$(openssl rand -base64 18)"

cat > "$ENV_FILE" <<EOF
POSTGRES_USER=factory
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
POSTGRES_DB=factory

GARAGE_RPC_SECRET=$GARAGE_RPC_SECRET
GARAGE_ACCESS_KEY=$GARAGE_ACCESS_KEY
GARAGE_SECRET_KEY=$GARAGE_SECRET_KEY
GARAGE_S3_HOST_PORT=3900

FACTORY_WEB_URL=http://localhost:3000
FACTORY_HTTP_PORT=3000

BREAK_GLASS_PASSWORD=$BREAK_GLASS_PASSWORD
EOF
chmod 600 "$ENV_FILE"

echo "factory-init: wrote $ENV_FILE and $MASTER_KEY_FILE (0600)."
echo ""
echo "Break-glass password (printed once, shown nowhere else):"
echo "  $BREAK_GLASS_PASSWORD"
echo ""
echo "Next: register the GitHub App (deploy/github-app/register-app.sh), then:"
echo "  docker compose up -d"
