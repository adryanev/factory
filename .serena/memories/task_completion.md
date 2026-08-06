# Completion gates

1. Inspect `git status` and intended diff; ignore unrelated user/tool changes and never revert them.
2. Run `pnpm run typecheck` from the root.
3. Run `pnpm run test` from the root; run serially when Docker/Testcontainers/Sandcastle are involved. If a failure is load-sensitive, rerun the failing package alone and then the full suite serially.
4. Run `pnpm --filter @factory/control-plane run check:openapi` after any control-plane route/schema change.
5. If schema changed, run `db:generate` and apply/verify migrations with `db:migrate` against an isolated database.
6. Review staged paths for secrets, `.env` files, tool caches, worktrees, `node_modules`, and generated junk before commit.
7. Commit only when requested by the workflow/user; use a concise Indonesian-style message matching existing history.