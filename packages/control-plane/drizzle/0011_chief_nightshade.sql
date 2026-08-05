CREATE TABLE "cron_skips" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"pipeline_repository_id" text NOT NULL,
	"pipeline_path" text NOT NULL,
	"ref_branch" text NOT NULL,
	"ref_sha" text NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"skipped_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "cron_skips_reason_check" CHECK ("cron_skips"."reason" in ('run-active'))
);
--> statement-breakpoint
CREATE TABLE "pending_automation_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"pipeline_repository_id" text NOT NULL,
	"pipeline_path" text NOT NULL,
	"ref_branch" text NOT NULL,
	"ref_sha" text NOT NULL,
	"definition" jsonb NOT NULL,
	"definition_files" jsonb NOT NULL,
	"service_account_principal_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "event_type" text NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "payload" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "processed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cron_skips" ADD CONSTRAINT "cron_skips_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cron_skips" ADD CONSTRAINT "cron_skips_pipeline_repository_id_repositories_id_fk" FOREIGN KEY ("pipeline_repository_id") REFERENCES "public"."repositories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_automation_runs" ADD CONSTRAINT "pending_automation_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_automation_runs" ADD CONSTRAINT "pending_automation_runs_pipeline_repository_id_repositories_id_fk" FOREIGN KEY ("pipeline_repository_id") REFERENCES "public"."repositories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cron_skips_project_id_id_idx" ON "cron_skips" USING btree ("project_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "pending_automation_runs_pipeline_ref_key" ON "pending_automation_runs" USING btree ("pipeline_repository_id","pipeline_path","ref_branch");--> statement-breakpoint
CREATE INDEX "pending_automation_runs_created_at_idx" ON "pending_automation_runs" USING btree ("created_at");