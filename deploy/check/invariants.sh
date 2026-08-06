#!/usr/bin/env sh
# invariants.sh — mechanically checks the self-host packaging invariants that
# must hold in this repo (issue #21). Each check is a grep over the files
# that carry the invariant, so a future edit that silently breaks one fails
# CI instead of shipping. Run from the repo root:
#
#   sh deploy/check/invariants.sh
#
# The checks, mapped to the acceptance criteria:
#   1. One compose file, one machine.  (AC: "Satu compose")
#   2. Web+API share a single image; no separate web service.  (AC: skew
#      impossible)
#   3. The control plane waits on the migrate service's
#      service_completed_successfully.  (AC: exactly one migrator by
#      construction)
#   4. Garage pinned exact — no `:latest` anywhere in the compose file, and
#      the pin is the load-bearing v2.3.0 with the single-node flags.
#      (AC: "Garage di-pin eksak dengan flag single-node")
#   5. Key material reaches the container as files mounted from
#      ./deploy/keys (compose secrets), and the master key lives at
#      /etc/factory/keys/master.key in the container.  (AC: two-tier
#      config)
#   6. The master key is outside the backup layout: no named volume or
#      backup destination may be ./deploy/keys, and the backup script must
#      not copy data directories.  (AC: "ditegakkan lewat tata letak path")
#   7. The migrate entrypoint is the real advisory-locked runner.  (AC:
#      migrations advisory-locked)
#   8. The operator guide documents: two hostnames, proxy read timeout
#      >= 60s, upgrade-as-downtime + drain, the unsupported list.  (ACs:
#      docs)
#   9. The runner ships as a JS tarball and the macOS installer verifies
#      isolation before identity.  (ACs: tarball, installer, gate)
set -eu

COMPOSE="compose.yaml"
FAILURES=0

check() {
  desc="$1"
  shift
  if [ "$#" -gt 0 ] && "$@"; then
    echo "ok   $desc"
  else
    echo "FAIL $desc"
    FAILURES=$((FAILURES + 1))
  fi
}

[ -f "$COMPOSE" ] || { echo "run from the repo root"; exit 2; }

# 1 — one compose file for the whole system (the garage/migrate spikes and
#     this file are all one file; nothing else composes services).
check "one compose file at the repo root" \
  sh -c '[ "$(find . -maxdepth 2 -name "compose*.y*ml" -not -path "./node_modules/*" -not -path "./.claude/*" | wc -l | tr -d " ")" -eq 1 ]'

# 2 — single image: the control-plane service builds, no web service exists.
check "no separate web service in compose" \
  sh -c 'grep -q "^  web:" "$1" && exit 1 || exit 0' sh "$COMPOSE"
check "control-plane service exists with a build" \
  sh -c 'grep -q "build:" "$1" && grep -q "dockerfile: deploy/images/control-plane/Dockerfile" "$1"' sh "$COMPOSE"
check "control plane serves the bundled web (FACTORY_WEB_DIST_DIR)" \
  sh -c 'grep -q "FACTORY_WEB_DIST_DIR: /app/web" "$1"' sh "$COMPOSE" 

# 3 — one-shot migrate + gate.
check "control plane waits on migrate: service_completed_successfully" \
  sh -c 'grep -q "migrate:" "$1" && grep -q "service_completed_successfully" "$1"' sh "$COMPOSE"
check "migrate service is one-shot (no restart)" \
  sh -c 'awk "/^  migrate:/{in_svc=1} in_svc && /restart:/{print; exit 1}" "$1" || exit 0' sh "$COMPOSE" 

# 4 — garage pinned exact.
check "garage image pinned (no :latest anywhere)" \
  sh -c 'grep -q "dxflrs/garage:v2.3.0" "$1" && ! grep -q ":latest" "$1"' sh "$COMPOSE"
check "garage runs with single-node flags" \
  sh -c 'grep -q "\-\-single-node" "$1" && grep -q "\-\-default-bucket" "$1" && grep -q "\-\-default-access-key" "$1"' sh "$COMPOSE" 

# 5 — two-tier config: key material as file secrets, passwords as env.
check "master key + app key mount as compose secrets from ./deploy/keys" \
  sh -c 'grep -q "file: ./deploy/keys/master.key" "$1" && grep -q "file: ./deploy/keys/github-app-private-key.pem" "$1"' sh "$COMPOSE"
check "master key target path is /etc/factory/keys/master.key" \
  sh -c 'grep -q "target: /etc/factory/keys/master.key" "$1"' sh "$COMPOSE"
check "control plane reads keys from files (not env material)" \
  sh -c 'grep -q "FACTORY_MASTER_KEY_FILE:" "$1" && grep -q "GITHUB_APP_PRIVATE_KEY_FILE:" "$1" && ! grep -q "GITHUB_APP_PRIVATE_KEY:" "$1"' sh "$COMPOSE"

# 6 — master key outside the backup layout.
check "deploy/keys appears only as secret file sources, never as a volume" \
  sh -c 'if grep -E "deploy/keys" "$1" | sed "s/^[[:space:]]*//" | grep -vE "^#|^file: ./deploy/keys/" | grep -q .; then exit 1; fi; grep -qE "file: ./deploy/keys/master.key" "$1" && grep -qE "file: ./deploy/keys/github-app-private-key.pem" "$1"' sh "$COMPOSE" 
check "backup script refuses to copy data directories (pg_dump + s3 sync only)" \
  sh -c 'grep -q "pg_dump" deploy/backup/backup.sh && grep -q "s3 sync" deploy/backup/backup.sh && ! grep -qE "cp .*(postgres|garage)" deploy/backup/backup.sh'
check "backup tripwire guards the master key path" \
  sh -c 'grep -q "MASTER_KEY_FILE" deploy/backup/backup.sh'

# 7 — the migrate entrypoint is the real advisory-locked runner.
check "migrate.sh execs the bundled Drizzle runner" \
  sh -c 'grep -q "exec node /app/dist/db/migrate.bundle.mjs" deploy/migrate/migrate.sh'
check "the migration runner takes the advisory lock" \
  sh -c 'grep -q "pg_advisory_lock" packages/control-plane/src/db/migrate.ts'

# 8 — operator docs.
check "docs: two hostnames (web+API, blob)" \
  sh -c 'grep -qi "hostname" docs/operating.md && grep -qi "blob" docs/operating.md'
check "docs: reverse proxy read timeout >= 60s" \
  sh -c 'grep -qi "read timeout" docs/operating.md && grep -qi "60" docs/operating.md'
check "docs: upgrade is downtime, drain before long upgrades" \
  sh -c 'grep -qi "downtime" docs/operating.md && grep -qi "drain" docs/operating.md'
check "docs: the unsupported list is explicit" \
  sh -c 'grep -qi "Kubernetes" docs/operating.md && grep -qi "rollback" docs/operating.md'
check "docs: GitHub App manifest flow" \
  sh -c 'grep -qi "manifest" docs/operating.md'

# 9 — runner packaging + isolation gate.
check "runner tarball script bundles JS for Node" \
  sh -c 'grep -q "esbuild" deploy/runner/build-runner-tarball.sh && grep -q "node:module" deploy/runner/build-runner-tarball.sh'
check "macOS installer verifies sha256" \
  sh -c 'grep -q "shasum -a 256" deploy/runner/install-macos.sh'
check "join is gated on isolation verification" \
  sh -c 'grep -q "verifyIsolation" packages/runner/src/join.ts && grep -q "joinRunner" packages/runner/src/main.ts'
check "isolation gate has a contract test" \
  sh -c 'grep -q "refuses to exchange the token" packages/runner/src/join.test.ts'

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "invariants.sh: all checks passed"
else
  echo "invariants.sh: $FAILURES check(s) FAILED"
  exit 1
fi
