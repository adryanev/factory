#!/usr/bin/env sh
# build-runner-tarball.sh — builds the Runner release artifact (spec
# "Packaging self-host", decision 5): a tarball of bundle JS + package.json,
# with Node >= 22 as the ONLY prerequisite. Pure JS end to end (sandcastle's
# own dependency tree is @clack/prompts, nothing native), so the same
# tarball serves linux-x64, linux-arm64, and darwin-arm64 — there is no
# per-platform build matrix, and nothing to cross-compile.
#
# Why a bundle and not the compiled workspace: @factory/shared exports its
# TypeScript source (packages/shared/package.json, `main: ./src/index.ts`),
# so a standalone runner needs @factory/shared and sandcastle inlined.
# esbuild does that; the ESM output gets the createRequire banner because
# yaml (a transitive dependency) does a dynamic `require()` that a bare
# ESM bundle cannot serve (verified: without the banner the bundle dies
# with "Dynamic require of \"process\" is not supported").
#
# The checksum is published next to the tarball on the same GitHub release
# (per decision 5: the SHA-256 detects broken downloads, not attackers —
# trust is HTTPS + the release account). macOS installers verify it before
# touching a byte.
#
# Usage: deploy/runner/build-runner-tarball.sh [version]
#   version defaults to 0.0.0; override with the release tag.
# Output: packages/runner/dist/factory-runner-<version>.tar.gz + .sha256
set -eu

VERSION="${1:-0.0.0}"
RUNNER_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../../packages/runner" && pwd)"
STAGE_DIR="$RUNNER_DIR/dist/tarball"
OUT_DIR="$RUNNER_DIR/dist"
BUNDLE="$STAGE_DIR/dist/main.js"

# Compile check first: the shipped bundle must come from source that
# typechecks.
(cd "$RUNNER_DIR" && pnpm run typecheck && pnpm run build)

rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR/dist"

(cd "$RUNNER_DIR" && pnpm exec esbuild src/main.ts \
  --bundle \
  --platform=node \
  --format=esm \
  --target=node22 \
  --banner:js="#!/usr/bin/env node
import { createRequire as __factoryCreateRequire } from 'node:module'; const require = __factoryCreateRequire(import.meta.url);" \
  --outfile="$BUNDLE" \
  --log-level=warning)
chmod +x "$BUNDLE"

cat > "$STAGE_DIR/package.json" <<EOF
{
  "name": "factory-runner",
  "version": "$VERSION",
  "private": false,
  "type": "module",
  "description": "factory Runner — joins the pool, claims StepRuns. Node >= 22 required; nothing else.",
  "bin": {
    "factory-runner": "./dist/main.js"
  },
  "engines": {
    "node": ">=22"
  }
}
EOF

cat > "$STAGE_DIR/README.md" <<'EOF'
# factory-runner

A self-contained bundle: Node >= 22 is the only prerequisite (macOS
machines already require Xcode for host-mode execution, and Xcode ships
neither; Homebrew node is the standard path).

Verify the checksum published on the release page before running:

    shasum -a 256 factory-runner-<version>.tar.gz

Then:

    tar xzf factory-runner-<version>.tar.gz
    ./dist/main.js join --control-plane <url> --token <join-token> \
      --identity <file> --agent-user <agent-os-user>
    ./dist/main.js run --identity <file>

`join` exchanges the one-time token ONLY after verifying the agent user
cannot read the identity file — a machine whose isolation is broken never
receives an identity (see docs/operating.md, "Isolation as the gate to
identity").
EOF

TARBALL="$OUT_DIR/factory-runner-$VERSION.tar.gz"
tar -czf "$TARBALL" -C "$STAGE_DIR" .
(cd "$OUT_DIR" && shasum -a 256 "factory-runner-$VERSION.tar.gz" > "factory-runner-$VERSION.tar.gz.sha256")

rm -rf "$STAGE_DIR"

echo "runner tarball: $TARBALL"
echo "sha256:         $OUT_DIR/factory-runner-$VERSION.tar.gz.sha256"
echo "contents:"
tar -tzf "$TARBALL" | sed 's/^/  /'
