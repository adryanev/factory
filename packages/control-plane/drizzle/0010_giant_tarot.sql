CREATE TABLE "pending_notifications" (
	"dedupe_key" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text,
	"kind" text NOT NULL,
	"send_after" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "pending_notifications_kind_check" CHECK ("pending_notifications"."kind" in ('question-issued', 'run-failed', 'daily-digest'))
);
--> statement-breakpoint
ALTER TABLE "pending_notifications" ADD CONSTRAINT "pending_notifications_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_notifications" ADD CONSTRAINT "pending_notifications_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pending_notifications_due_idx" ON "pending_notifications" USING btree ("send_after") WHERE "pending_notifications"."sent_at" is null;--> statement-breakpoint
CREATE INDEX "pending_notifications_project_idx" ON "pending_notifications" USING btree ("project_id");