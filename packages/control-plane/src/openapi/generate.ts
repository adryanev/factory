import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOpenApiDocument } from "./document.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const outputPath = path.resolve(here, "../../openapi.json");

const document = buildOpenApiDocument();
writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`);
console.log(`wrote ${outputPath}`);
