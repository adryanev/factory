/**
 * Drizzle schema barrel. `drizzle.config.ts` and `db/client.ts` both import
 * this single file, so every table Drizzle needs to know about — the
 * scaffold-only table below and the full domain schema in `db/schema/` —
 * has to be reachable from here.
 *
 * This file also documents the conventions every later table follows —
 * issue #2 exists to establish them, not to build the full 22-table schema
 * from the spec (`.scratch/distributed-software-factory/spec.md`,
 * "Skema database"). Each later issue owns and adds its own tables in
 * `db/schema/`.
 *
 * Conventions:
 *
 * 1. Closed value sets use `text` + `CHECK`, never `pgEnum`. The spec's
 *    reasoning: enum sets grow (Question's `kind` went from three to four
 *    variants), and Postgres enums are painful to widen. The cost is
 *    accepted explicitly: a stray SQL string can't be caught by the type
 *    system the way `pgEnum` would catch it — that's a trade, not an
 *    oversight.
 * 2. Id columns are the prefixed base32 id from `@factory/shared` (`text`,
 *    not `uuid`), generated client-side and written as-is — never
 *    `defaultRandom()` or a server-side sequence.
 * 3. Keyset pagination indexes are shaped `(project_id, id DESC)`, because
 *    the id already sorts by creation time (see `packages/shared/src/id.ts`)
 *    — no separate `created_at` column is needed for ordering.
 *    `scaffold_probes` below has no `project_id` (it isn't a Project-scoped
 *    entity), so it indexes on `id DESC` alone; real Project-scoped tables
 *    follow the two-column form.
 */

import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export * from "./schema/index.js";

/** Closed value set for `scaffold_probes.status` — convention 1 above. */
export const scaffoldProbeStatuses = ["ok", "degraded"] as const;
export type ScaffoldProbeStatus = (typeof scaffoldProbeStatuses)[number];

/**
 * Scaffold-only table. It exists to give issue #2's seam-1 rig something
 * real to write to and read back — a proof that migrations, the id
 * convention, and the REST-to-Postgres path all work end to end. It is not
 * one of the spec's 22 domain tables and carries no product meaning.
 */
export const scaffoldProbes = pgTable(
  "scaffold_probes",
  {
    id: text("id").primaryKey(),
    status: text("status").notNull().default("ok" satisfies ScaffoldProbeStatus),
    message: text("message").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "scaffold_probes_status_check",
      sql`${table.status} in ('ok', 'degraded')`,
    ),
    index("scaffold_probes_id_idx").on(table.id.desc()),
  ],
);
