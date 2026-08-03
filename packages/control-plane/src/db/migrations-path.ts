import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Where drizzle-kit writes migration SQL + `meta/_journal.json`. */
export const MIGRATIONS_FOLDER = path.resolve(here, "../../drizzle");
