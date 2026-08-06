import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Runs in every worker process before any test file — see test-setup.ts:
    // sandcastle writes git's global config, and no test may touch the real one.
    setupFiles: ["./test-setup.ts"],
  },
});
