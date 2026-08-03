// Plain Node fs, no jsdom needed.
//
// Regression test for the rule in spec.md "Bahasa visual": --attention is
// narrowed to "written by a human into an Artifact" and must not be reused
// for warnings, pending states, "current row" highlights, or anything else.
// This scans the token layer and every primitive source file and fails the
// moment a second call site starts touching --attention, so the narrowing
// survives future edits instead of relying on someone remembering the rule.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..", ".."); // packages/web/src

const ALLOWED_FILES = new Set([
  "tokens/tokens.css", // defines --attention
  "tokens/colors.ts", // the one narrow accessor: humanWrittenInArtifactColor
  "primitives/HumanAuthoredMark.tsx", // the one primitive allowed to use it
  "primitives/HumanAuthoredMark.css",
]);

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "node_modules") continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx|css)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("--attention token usage", () => {
  it("appears only where the narrowing rule allows it", () => {
    const files = [
      ...listSourceFiles(join(srcRoot, "tokens")),
      ...listSourceFiles(join(srcRoot, "primitives")),
    ];
    const offenders = files
      .map((path) => ({
        rel: relative(srcRoot, path).split("\\").join("/"),
        text: readFileSync(path, "utf8"),
      }))
      .filter(({ rel, text }) => text.includes("--attention") && !ALLOWED_FILES.has(rel))
      .map(({ rel }) => rel);

    expect(offenders).toEqual([]);
  });
});
