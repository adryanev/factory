# Project commands

- Install: `pnpm install`
- Full gates: `pnpm run typecheck && pnpm run test && pnpm run check:openapi`
- Per package: `pnpm --filter @factory/<package> run typecheck`; `pnpm --filter @factory/<package> run test`
- Control-plane migration generation: `pnpm --filter @factory/control-plane run db:generate`
- Apply migrations: `DATABASE_URL=... pnpm --filter @factory/control-plane run db:migrate`
- OpenAPI: `pnpm run generate:openapi`, then `pnpm run check:openapi`
- Local processes: `pnpm --filter @factory/control-plane run dev`, `pnpm --filter @factory/runner run dev`, `pnpm --filter @factory/web run dev`
- Issue context: `gh issue view <number>` and `gh issue list`; implementation uses isolated git worktrees under `.claude/worktrees/`.
- Avoid running multiple full Vitest suites concurrently on constrained Docker hosts; Sandcastle/Testcontainers timing failures can appear under resource contention. Verify full suites serially.