import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // Seam-1 tests boot a real Postgres container; give them room.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
