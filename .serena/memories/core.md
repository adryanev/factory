# Factory project map

- pnpm monorepo with `packages/shared`, `packages/control-plane`, `packages/runner`, `packages/web`; GitHub Issues on `adryanev/factory` are the implementation tickets.
- Control plane owns Postgres state, authorization, graph transitions, leases, and OpenAPI routes. Routes receive injected `AppDeps`; domain modules own DB writes.
- Runner owns sandbox execution and peer-to-peer Git/Garage transfers; control plane must not proxy blob bytes.
- Shared owns pipeline schemas/output/question contracts consumed by control plane, runner, and web; keep one schema rather than duplicate validation.
- Seam-1 tests use disposable Postgres/Testcontainers and migrations as shipped. Real local deployment can use Lexicon Core Postgres, but never commit credentials.
- Read `mem:tech_stack` for package/version facts, `mem:conventions` for architectural invariants, and `mem:task_completion` before declaring changes complete.