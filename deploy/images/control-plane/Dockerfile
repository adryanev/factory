# The single web+control-plane image (spec "Packaging self-host", decision 3):
# one artifact carries the API and the Vite bundle it serves, so web<->API
# skew is structurally impossible — the bundle on the wire is always the
# bundle this API was released with.
#
# Runtime shape (all pure JS, node:22-alpine, matching CI's node 22):
#   /app/dist/db/main.bundle.mjs     the control-plane server (esbuild bundle)
#   /app/dist/db/migrate.bundle.mjs  the one-shot migration runner
#   /app/dist/db/sql/*.sql           the three hand-written SQL files, next to
#                                    the code that reads them at runtime
#   /app/drizzle/                    migration files + meta/_journal.json
#   /app/web/                        the Vite build (FACTORY_WEB_DIST_DIR)
#
# Bundles live in dist/db/ because the code resolves its data files with
# `../../drizzle` and `./sql` relative to the module URL — the same shape
# as src/db/ in the source tree, so dev and image resolve identically.
#
# Bundling exists because @factory/shared exports its TypeScript source
# (`main: ./src/index.ts`) — a runtime `node` process must not run raw
# source, and esbuild inlines it into the bundle, so the runtime stage
# needs no node_modules at all.
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app

# Manifests first: layer-cached across rebuilds, and --frozen-lockfile keeps
# the image from silently resolving anything the lockfile doesn't pin.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/control-plane/package.json packages/control-plane/
COPY packages/runner/package.json packages/runner/
COPY packages/web/package.json packages/web/
RUN pnpm install --frozen-lockfile

# The full source (see .dockerignore for what is kept out of the context).
COPY . .

# tsc compiles the API surface (and copies the hand-written SQL into
# dist/db/sql, which is also what the runtime stage uses);
# esbuild bundles the two entrypoints so the runtime stage is bare node.
# The createRequire banner is required: pg (a dependency) does a dynamic
# `require()` that a bare ESM bundle cannot serve — without the banner the
# process dies at import time with "Dynamic require of ... is not
# supported" (same banner as deploy/runner/build-runner-tarball.sh).
# The bundled loaders read their hand-written SQL with `path.join(here,
# fileName)` — src/db/sql/load.ts resolves identically in the source tree —
# so the .sql files must sit next to the bundles, not in dist/db/sql.
RUN pnpm --filter @factory/shared run build \
  && pnpm --filter @factory/control-plane run build \
  && pnpm --filter @factory/web run build \
  && pnpm --filter @factory/control-plane exec esbuild src/main.ts \
       --bundle --platform=node --format=esm --target=node22 \
       --banner:js="import { createRequire as __factoryCreateRequire } from 'node:module'; const require = __factoryCreateRequire(import.meta.url);" \
       --outfile=dist/db/main.bundle.mjs \
  && pnpm --filter @factory/control-plane exec esbuild src/db/migrate.ts \
       --bundle --platform=node --format=esm --target=node22 \
       --banner:js="import { createRequire as __factoryCreateRequire } from 'node:module'; const require = __factoryCreateRequire(import.meta.url);" \
       --outfile=dist/db/migrate.bundle.mjs \
  && cp packages/control-plane/src/db/sql/*.sql packages/control-plane/dist/db/

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    FACTORY_WEB_DIST_DIR=/app/web
WORKDIR /app
COPY --from=build /app/packages/control-plane/dist/ ./dist/
COPY --from=build /app/packages/control-plane/drizzle/ ./drizzle/
COPY --from=build /app/packages/web/dist/ ./web/
# The image carries no entrypoint script: compose runs
#   node dist/db/main.bundle.mjs      (the control-plane service)
#   sh /migrate.sh                    (the one-shot migrate service, with
#                                      deploy/migrate/migrate.sh mounted)
# Key material never enters this image — it is mounted from ./deploy/keys at
# runtime (see compose.yaml, "Config split").
CMD ["node", "dist/db/main.bundle.mjs"]
