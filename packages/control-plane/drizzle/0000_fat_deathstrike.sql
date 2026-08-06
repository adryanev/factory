CREATE TABLE "scaffold_probes" (
	"id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'ok' NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scaffold_probes_status_check" CHECK ("scaffold_probes"."status" in ('ok', 'degraded'))
);
--> statement-breakpoint
CREATE INDEX "scaffold_probes_id_idx" ON "scaffold_probes" USING btree ("id" DESC NULLS LAST);