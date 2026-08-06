CREATE TABLE "price_versions" (
	"version" text PRIMARY KEY NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"input_token_usd_per_million" numeric(12, 6) NOT NULL,
	"output_token_usd_per_million" numeric(12, 6) NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE INDEX "price_versions_effective_at_idx" ON "price_versions" USING btree ("effective_at");--> statement-breakpoint
ALTER TABLE "step_run_costs" ADD CONSTRAINT "step_run_costs_price_version_price_versions_version_fk" FOREIGN KEY ("price_version") REFERENCES "public"."price_versions"("version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Seed the initial price version (issue 12, spec: "Cost"): a step-run cost
-- row always pins to a price_versions row, so the table must never be empty.
-- Prices are USD per one million tokens; the numbers are the initial policy,
-- replaced by appending newer versions (insert-only — never an UPDATE here).
INSERT INTO "price_versions" ("version", "effective_at", "input_token_usd_per_million", "output_token_usd_per_million", "note") VALUES ('v1', '2026-01-01T00:00:00.000Z', 3.000000, 15.000000, 'Initial pricing policy.');
