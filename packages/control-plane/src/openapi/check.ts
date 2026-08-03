/**
 * CI drift gate: the committed `openapi.json` must be exactly what the
 * generator produces from the current Zod route definitions. Run by the
 * `check:openapi` script (wired into GitHub Actions) so a route change
 * without a regenerated doc goes red instead of shipping silently stale.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOpenApiDocument } from "./document.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const committedPath = path.resolve(here, "../../openapi.json");

const generated = `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;

let committed: string;
try {
  committed = readFileSync(committedPath, "utf-8");
} catch {
  console.error(`openapi.json is missing. Run \`pnpm run generate:openapi\` and commit it.`);
  process.exit(1);
}

if (committed !== generated) {
  console.error(
    "openapi.json is stale: the generator's output no longer matches the committed file. Run `pnpm run generate:openapi` and commit the result.",
  );
  process.exit(1);
}

console.log("openapi.json is up to date");
