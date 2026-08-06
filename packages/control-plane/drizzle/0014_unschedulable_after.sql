ALTER TABLE "step_runs" DROP CONSTRAINT "step_runs_outcome_check";--> statement-breakpoint
ALTER TABLE "step_runs" ADD COLUMN "unschedulable_after" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "step_runs_unschedulable_ready_idx" ON "step_runs" USING btree ("unschedulable_after") WHERE "step_runs"."outcome" = 'ready';--> statement-breakpoint
ALTER TABLE "step_runs" ADD CONSTRAINT "step_runs_outcome_check" CHECK ("step_runs"."outcome" in ('ready', 'running', 'awaiting-human', 'succeeded', 'failed', 'skipped', 'cancelled', 'unschedulable'));