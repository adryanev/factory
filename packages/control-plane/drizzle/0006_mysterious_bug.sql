CREATE TABLE "step_run_upload_grants" (
	"step_run_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"blob_key" text NOT NULL,
	"granted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "step_run_upload_grants_step_run_id_attempt_key_kind_pk" PRIMARY KEY("step_run_id","attempt","key","kind"),
	CONSTRAINT "step_run_upload_grants_kind_check" CHECK ("step_run_upload_grants"."kind" in ('artifact', 'session', 'log'))
);
--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "kind" text NOT NULL;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "created_at" timestamp with time zone NOT NULL;--> statement-breakpoint
ALTER TABLE "step_run_upload_grants" ADD CONSTRAINT "step_run_upload_grants_step_run_id_step_runs_id_fk" FOREIGN KEY ("step_run_id") REFERENCES "public"."step_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_kind_check" CHECK ("artifacts"."kind" in ('diff', 'transcript', 'document', 'structured', 'command-output', 'binary'));