#!/usr/bin/env bash
# install-macos.sh — the factory Runner installer for macOS (spec
# "Packaging self-host", decision 6).
#
# This script is meant to be READ BEFORE it is run: it creates two OS users
# and installs a root launchd daemon. It is a plain, readable shell script
# on purpose — a .pkg could not be inspected, and would demand the same
# Developer ID + notarization signing as a single binary, for zero benefit
# on machines that already must run Xcode.
#
# What it does, in order:
#   1. Verifies prerequisites: root, Node >= 22, Xcode command line tools
#      (the installer does NOT install Xcode — that needs an Apple ID and
#      is outside a script's authority; it stops with instructions).
#   2. Verifies the tarball's SHA-256 against the published checksum
#      (detects broken downloads; trust is HTTPS + the release account).
#   3. Creates the two OS users (idempotent): `_factory` — the Runner runs
#      as this user; `_factoryjob` — the agent runs as this user in
#      exec:host mode. The separation is the isolation boundary: without
#      it, the agent could read the Runner's secret file and promote
#      itself.
#   4. Installs the tarball under /usr/local/factory/runner, owned by
#      `_factory`.
#   5. Creates the identity file (runner.secret), empty, mode 0600, owned
#      by `_factory` — the file `join` later fills.
#   6. Installs the launchd daemon (KeepAlive, runs as `_factory`) so the
#      Runner comes back after reboot.
#   7. RUNS THE POSTCONDITIONS and only prints the join command when every
#      one passes. The real gate, though, lives in the runner binary:
#      `join` re-verifies that the agent user cannot read runner.secret
#      BEFORE exchanging the join token, so a half-finished install can
#      never produce a machine that holds a Runner identity it doesn't
#      deserve ("verifikasi isolasi jadi gerbang menuju identitas").
#
# Idempotent: every step checks before it changes; a failure mid-way is
# fixed by re-running the script. Nothing is half-registered.
#
# Usage (as root):
#   sudo ./install-macos.sh --tarball <path-or-url> --sha256 <published>
#     [--runner-user _factory] [--agent-user _factoryjob]
#     [--install-dir /usr/local/factory/runner]
#     [--identity /usr/local/factory/runner/runner.secret]
#     [--control-plane <url>]   # optional: prints the ready-to-paste join command
set -euo pipefail

TARBALL=""
EXPECTED_SHA256=""
RUNNER_USER="_factory"
AGENT_USER="_factoryjob"
INSTALL_DIR="/usr/local/factory/runner"
IDENTITY_FILE="/usr/local/factory/runner/runner.secret"
CONTROL_PLANE_URL=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --tarball) TARBALL="${2:-}"; shift 2 ;;
    --sha256) EXPECTED_SHA256="${2:-}"; shift 2 ;;
    --runner-user) RUNNER_USER="${2:-}"; shift 2 ;;
    --agent-user) AGENT_USER="${2:-}"; shift 2 ;;
    --install-dir) INSTALL_DIR="${2:-}"; shift 2 ;;
    --identity) IDENTITY_FILE="${2:-}"; shift 2 ;;
    --control-plane) CONTROL_PLANE_URL="${2:-}"; shift 2 ;;
    *) echo "install-macos: unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$TARBALL" ] || [ -z "$EXPECTED_SHA256" ]; then
  echo "install-macos: --tarball and --sha256 are required (see docs/operating.md)." >&2
  exit 2
fi

fail() {
  echo "install-macos: $1" >&2
  echo "install-macos: re-run this script after fixing the problem — it is idempotent." >&2
  exit 1
}

if [ "$(id -u)" -ne 0 ]; then
  fail "run this installer as root: sudo ./install-macos.sh ..."
fi

echo "install-macos: prerequisites..."

command -v node >/dev/null 2>&1 || fail "Node is required (>= 22). Install it first: brew install node"
NODE_VERSION="$(node --version | sed 's/^v//')"
if ! printf '%s\n%s\n' "22" "$NODE_VERSION" | sort -V | head -n1 | grep -q '^22$'; then
  fail "Node >= 22 required, found $NODE_VERSION. Install it first: brew install node"
fi

if ! xcode-select -p >/dev/null 2>&1; then
  fail "Xcode command line tools are not installed. Run: xcode-select --install (Xcode itself is required for exec:host agent runs; the installer does not install it because it needs an Apple ID)."
fi
if ! xcodebuild -checkFirstLaunchStatus >/dev/null 2>&1; then
  fail "The Xcode license has not been accepted. Run: sudo xcodebuild -license accept"
fi

echo "install-macos: verifying the tarball checksum..."
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
if [[ "$TARBALL" == http://* || "$TARBALL" == https://* ]]; then
  curl -fsSL -o "$WORK_DIR/runner.tar.gz" "$TARBALL"
else
  cp "$TARBALL" "$WORK_DIR/runner.tar.gz"
fi
ACTUAL_SHA256="$(shasum -a 256 "$WORK_DIR/runner.tar.gz" | awk '{print $1}')"
if [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then
  fail "checksum mismatch: expected $EXPECTED_SHA256, got $ACTUAL_SHA256. The download is corrupt or tampered with — do not install."
fi

echo "install-macos: users..."

ensure_user() {
  local user="$1"
  if id -u "$user" >/dev/null 2>&1; then
    echo "  $user already exists"
    return
  fi
  # A real user account with a login shell it never gets: the runner user
  # never logs in; the agent user never even starts a session.
  sysadminctl -addUser "$user" -home /var/empty -shell /usr/bin/false -password '*' 2>/dev/null \
    || fail "could not create user $user (sysadminctl failed)"
  echo "  created $user"
}
ensure_user "$RUNNER_USER"
ensure_user "$AGENT_USER"

echo "install-macos: installing the runner bundle..."
mkdir -p "$INSTALL_DIR"
tar -xzf "$WORK_DIR/runner.tar.gz" -C "$INSTALL_DIR"
chown -R "$RUNNER_USER" "$INSTALL_DIR"
chmod -R o-rwx "$INSTALL_DIR"

echo "install-macos: identity file placeholder (0600, owned by $RUNNER_USER)..."
mkdir -p "$(dirname "$IDENTITY_FILE")"
touch "$IDENTITY_FILE"
chown "$RUNNER_USER" "$IDENTITY_FILE"
chmod 600 "$IDENTITY_FILE"

echo "install-macos: launchd daemon (KeepAlive, runs as $RUNNER_USER)..."
NODE_BIN="$(command -v node)"
PLIST="/Library/LaunchDaemons/com.factory.runner.plist"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.factory.runner</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$INSTALL_DIR/dist/main.js</string>
    <string>run</string>
    <string>--identity</string>
    <string>$IDENTITY_FILE</string>
  </array>
  <key>UserName</key><string>$RUNNER_USER</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/var/log/factory-runner.log</string>
  <key>StandardErrorPath</key><string>/var/log/factory-runner.log</string>
</dict>
</plist>
EOF
chmod 644 "$PLIST"
launchctl bootout system/com.factory.runner >/dev/null 2>&1 || true
launchctl bootstrap system "$PLIST" >/dev/null 2>&1 || true
launchctl enable system/com.factory.runner || true

echo "install-macos: postconditions (isolation is the gate to identity)..."
POSTCONDITIONS_OK=1

id -u "$RUNNER_USER" >/dev/null 2>&1 || { echo "  FAIL: $RUNNER_USER missing"; POSTCONDITIONS_OK=0; }
id -u "$AGENT_USER" >/dev/null 2>&1 || { echo "  FAIL: $AGENT_USER missing"; POSTCONDITIONS_OK=0; }

MODE="$(stat -f '%Lp' "$IDENTITY_FILE")"
OWNER="$(stat -f '%Su' "$IDENTITY_FILE")"
[ "$MODE" = "600" ] || { echo "  FAIL: $IDENTITY_FILE mode is $MODE, want 600"; POSTCONDITIONS_OK=0; }
[ "$OWNER" = "$RUNNER_USER" ] || { echo "  FAIL: $IDENTITY_FILE owner is $OWNER, want $RUNNER_USER"; POSTCONDITIONS_OK=0; }

# The isolation probe: the agent user MUST NOT be able to read the Runner's
# secret file. A successful `cat` here means the whole install is void.
if sudo -u "$AGENT_USER" cat "$IDENTITY_FILE" >/dev/null 2>&1; then
  echo "  FAIL: $AGENT_USER can read $IDENTITY_FILE — the agent could promote itself to a Runner."
  POSTCONDITIONS_OK=0
else
  echo "  OK: $AGENT_USER cannot read $IDENTITY_FILE"
fi

launchctl print system/com.factory.runner >/dev/null 2>&1 || { echo "  FAIL: launchd daemon not loaded"; POSTCONDITIONS_OK=0; }

if [ "$POSTCONDITIONS_OK" -ne 1 ]; then
  fail "postconditions failed — this machine must NOT receive a Runner identity. Re-run after fixing."
fi

echo ""
echo "install-macos: done. Isolation verified: the agent user cannot read the Runner secret."
if [ -n "$CONTROL_PLANE_URL" ]; then
  echo "Next — exchange a join token (mint it in the UI as an org owner):"
  echo "  sudo $INSTALL_DIR/dist/main.js join \\"
  echo "    --control-plane $CONTROL_PLANE_URL \\"
  echo "    --token <one-time-join-token> \\"
  echo "    --identity $IDENTITY_FILE --agent-user $AGENT_USER"
  echo "The join command re-verifies isolation before the token is exchanged."
fi
