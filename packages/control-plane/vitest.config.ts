import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // The reaper every container start depends on is a host-wide singleton
    // raced by all workers; make it actually ready before any suite boots a
    // container (issue #31).
    globalSetup: ["./test/reaper-warmup.ts"],
    // Seam-1 tests boot a real Postgres container; give them room. The
    // container readiness waits are condition-based with a 240s budget
    // (test/postgres-container.ts), so a hook budget below that could never
    // let the wait run its course — the hook must outlive the container's
    // own budget, not the other way around.
    testTimeout: 60_000,
    hookTimeout: 300_000,
  },
});
