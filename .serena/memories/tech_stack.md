# Toolchain and packages

- Node `>=20`; package manager `pnpm@11.14.0`; TypeScript ESM.
- Root scripts: `pnpm run typecheck`, `pnpm run build`, `pnpm run test`, `pnpm run generate:openapi`, `pnpm run check:openapi`.
- Control plane: Hono/OpenAPI, Drizzle ORM + `pg`, Zod 4, Vitest, Testcontainers; scripts include `db:generate`, `db:migrate`, `generate:openapi`, `check:openapi`.
- Runner pins `@ai-hero/sandcastle` exactly at `0.12.0`; all Sandcastle imports belong under `packages/runner/src/agent-runtime/`.
- Web: React 18, Vite 6, Vitest + Testing Library + jsdom.
- Database migrations are under `packages/control-plane/drizzle/`; generated metadata is under `drizzle/meta/`. Handwritten SQL is under `packages/control-plane/src/db/sql/`.