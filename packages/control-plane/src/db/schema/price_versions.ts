import { index, numeric, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * The pricing policy table (issue 12, spec: "Cost"). Insert-only: a new
 * price state is a new row, never an UPDATE — which is what makes a
 * `step_run_costs.price_version` reference truthful history. The control
 * plane looks this table up once at StepRun end, prices the reported usage,
 * and pins `price_version` to the row it used; nothing anywhere multiplies
 * the price table again after the cost is written (spec: "tidak ada
 * tampilan yang mengalikan ulang saat tabel harga berubah").
 *
 * The first row (`v1`) is seeded by migration 0007; an operator appends
 * newer versions over time. The "current" version is the most recently
 * effective one — `ORDER BY effective_at DESC, version DESC LIMIT 1` — with
 * no clock dependency at read time, since the prices it carries are only
 * ever read, never time-qualified.
 *
 * Prices are USD per one million tokens. The numbers are a policy decision,
 * not a mechanism one; the mechanism this table exists for is the
 * version-pinning guarantee above.
 */
export const priceVersions = pgTable(
  "price_versions",
  {
    version: text("version").primaryKey(),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
    inputTokenUsdPerMillion: numeric("input_token_usd_per_million", { precision: 12, scale: 6 }).notNull(),
    outputTokenUsdPerMillion: numeric("output_token_usd_per_million", { precision: 12, scale: 6 }).notNull(),
    /** Why this version exists — an operator note, never read by code. */
    note: text("note"),
  },
  (table) => [
    // The "current version" lookup: the most recently effective row.
    index("price_versions_effective_at_idx").on(table.effectiveAt),
  ],
);
