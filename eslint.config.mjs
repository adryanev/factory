// @ts-check
//
// Linter choice (issue #29): typescript-eslint with type-aware rules.
//
// The codebase is async-heavy — control-plane, runner, and shared are Node
// services built around awaited database/network work — and the error classes
// that actually happened during development (dropped promises, `await`
// missing on discarded promises, floating promises) are exactly what only
// type-aware rules can catch. Biome/oxlint would be faster but neither can
// flag a floating promise at type level. Hence `recommendedTypeChecked`,
// which pulls in `no-floating-promises` and `no-misused-promises`.
//
// `projectService: true` makes each linted file resolve to the tsconfig.json
// that already covers it (one per package, ESM + NodeNext, strict). Files
// that no tsconfig includes (vite/vitest/drizzle configs, runner test-setup)
// fall back to the default project via allowDefaultProject — the default
// project has no type information, so those files get non-type-aware rules
// only (the `disableTypeChecked` block below), mirroring the fact that
// `tsc --noEmit` does not cover them either.
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**"],
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            "packages/control-plane/drizzle.config.ts",
            "packages/control-plane/vitest.config.ts",
            "packages/runner/test-setup.ts",
            "packages/runner/vitest.config.ts",
            "packages/shared/vitest.config.ts",
            "packages/web/vite.config.ts",
            "packages/web/vitest.config.ts",
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Files outside every tsconfig (see header). The default project knows no
    // types, so every type-aware rule would report "could not be resolved"
    // noise here; typecheck does not cover these files either.
    files: [
      "packages/control-plane/drizzle.config.ts",
      "packages/control-plane/vitest.config.ts",
      "packages/runner/test-setup.ts",
      "packages/runner/vitest.config.ts",
      "packages/shared/vitest.config.ts",
      "packages/web/vite.config.ts",
      "packages/web/vitest.config.ts",
    ],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    rules: {
      // Variable shadowing hides bugs (an inner scope silently reusing an
      // outer name). Not in the recommended set; issue #29 names it
      // explicitly, so it is on.
      "@typescript-eslint/no-shadow": "error",

      // Every hit in this repo is a test double implementing an async
      // interface (ProtocolClient, GitHost, ObjectStore, sandcastle Runtime)
      // with a synchronous body. TypeScript rejects dropping `async` from an
      // interface implementation (TS2322/TS2416), so the only "fix" the rule
      // would accept is `await Promise.resolve()` noise. The rule's real
      // target — async production code that awaits nothing, i.e. a missing
      // `await` or a dead promise API — has zero hits in src/.
      "@typescript-eslint/require-await": "off",

      // The no-unsafe-* family is off by decision: this codebase's `any`
      // surfaces are runtime-validated data — raw SQL rows (pg results in
      // tests and sweep loops), YAML document traversal (pipeline/errors.ts),
      // JWT payloads, JSON.parse of wire bodies — and the rule would demand
      // typing every one of those boundaries, a data-layer typing work item
      // in its own right, not a bug class this adoption is meant to gate.
      // Every hit was audited: none hides a defect reachable from the typed
      // paths; the meaningful type-aware rules below stay fully on.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
);
