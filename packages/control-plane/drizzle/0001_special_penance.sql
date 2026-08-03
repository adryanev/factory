CREATE TABLE "principals" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	CONSTRAINT "principals_kind_check" CHECK ("principals"."kind" in ('user', 'service_account'))
);
--> statement-breakpoint
CREATE TABLE "service_accounts" (
	"principal_id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"principal_id" text PRIMARY KEY NOT NULL,
	"github_user_id" bigint,
	"github_login" text,
	"name" text,
	"avatar_url" text,
	"password_hash" text,
	CONSTRAINT "users_github_user_id_unique" UNIQUE("github_user_id")
);
--> statement-breakpoint
CREATE TABLE "org_members" (
	"principal_id" text PRIMARY KEY NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	CONSTRAINT "org_members_role_check" CHECK ("org_members"."role" in ('owner', 'member'))
);
--> statement-breakpoint
CREATE TABLE "group_members" (
	"group_id" text NOT NULL,
	"principal_id" text NOT NULL,
	CONSTRAINT "group_members_group_id_principal_id_pk" PRIMARY KEY("group_id","principal_id")
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "groups_project_name_key" UNIQUE("project_id","name")
);
--> statement-breakpoint
CREATE TABLE "project_members" (
	"project_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"role" text NOT NULL,
	CONSTRAINT "project_members_project_id_principal_id_pk" PRIMARY KEY("project_id","principal_id"),
	CONSTRAINT "project_members_role_check" CHECK ("project_members"."role" in ('admin', 'member'))
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"automation_enabled" boolean DEFAULT true NOT NULL,
	"allow_shared_agent_credential" boolean DEFAULT false NOT NULL,
	"host_exec_allowed" boolean DEFAULT false NOT NULL,
	"notification_webhook_url" text
);
--> statement-breakpoint
CREATE TABLE "github_app_installations" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"installation_id" bigint NOT NULL,
	"account_login" text NOT NULL,
	CONSTRAINT "github_app_installations_installation_id_unique" UNIQUE("installation_id")
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"github_app_installation_id" text NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"default_branch" text NOT NULL,
	CONSTRAINT "repositories_owner_name_key" UNIQUE("owner","name")
);
--> statement-breakpoint
CREATE TABLE "secrets" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"owner_principal_id" text NOT NULL,
	"name" text NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"nonce" "bytea" NOT NULL,
	"auth_tag" "bytea" NOT NULL,
	"key_version" integer NOT NULL,
	CONSTRAINT "secrets_project_name_key" UNIQUE("project_id","name")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text,
	"actor_principal_id" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"pipeline_repository_id" text NOT NULL,
	"pipeline_path" text NOT NULL,
	"trigger_kind" text NOT NULL,
	"triggered_by_principal_id" text NOT NULL,
	"credential_principal_id" text NOT NULL,
	"ref_branch" text NOT NULL,
	"ref_sha" text NOT NULL,
	"parent_run_id" text,
	"definition" jsonb NOT NULL,
	"definition_files" jsonb NOT NULL,
	"cancel_requested_at" timestamp with time zone,
	"outcome" text,
	"ended_at" timestamp with time zone,
	"artifacts_purged_at" timestamp with time zone,
	"logs_purged_at" timestamp with time zone,
	"branches_purged_at" timestamp with time zone,
	CONSTRAINT "runs_trigger_kind_check" CHECK ("runs"."trigger_kind" in ('automation', 'manual')),
	CONSTRAINT "runs_outcome_check" CHECK ("runs"."outcome" is null or "runs"."outcome" in ('succeeded', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "step_run_costs" (
	"step_run_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"tokens" jsonb,
	"cost_usd" numeric(12, 6),
	"price_version" text,
	CONSTRAINT "step_run_costs_step_run_id_attempt_pk" PRIMARY KEY("step_run_id","attempt")
);
--> statement-breakpoint
CREATE TABLE "step_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"repository_id" text NOT NULL,
	"step_key" text NOT NULL,
	"branch_key" text,
	"turn" integer NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"outcome" text DEFAULT 'ready' NOT NULL,
	"reason" text,
	"kind" text,
	"required_tags" text[] DEFAULT '{}' NOT NULL,
	"ready_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"leased_by" text,
	"lease_token" text,
	"lease_expires_at" timestamp with time zone,
	"output_ref_branch" text,
	"output_ref_sha" text,
	"output_data" jsonb,
	"session_blob_key" text,
	"session_purged_at" timestamp with time zone,
	CONSTRAINT "step_runs_natural_key" UNIQUE NULLS NOT DISTINCT("run_id","step_key","branch_key","turn"),
	CONSTRAINT "step_runs_branch_key_not_empty_check" CHECK ("step_runs"."branch_key" is null or length("step_runs"."branch_key") > 0),
	CONSTRAINT "step_runs_outcome_check" CHECK ("step_runs"."outcome" in ('ready', 'running', 'awaiting-human', 'succeeded', 'failed', 'skipped', 'cancelled')),
	CONSTRAINT "step_runs_kind_check" CHECK ("step_runs"."kind" is null or "step_runs"."kind" = 'pull-request')
);
--> statement-breakpoint
CREATE TABLE "questions" (
	"id" text PRIMARY KEY NOT NULL,
	"step_run_id" text NOT NULL,
	"kind" text NOT NULL,
	"body" text NOT NULL,
	"options" jsonb,
	"multi" boolean,
	"allow_other" boolean,
	"artifact_key" text,
	"group_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone,
	"answered_by_principal_id" text,
	"answer" jsonb,
	CONSTRAINT "questions_kind_check" CHECK ("questions"."kind" in ('text', 'choice', 'approval', 'edit-artifact'))
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"step_run_id" text NOT NULL,
	"key" text NOT NULL,
	"content_type" text NOT NULL,
	"blob_key" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"authored_by_principal_id" text,
	CONSTRAINT "artifacts_step_run_key_key" UNIQUE("step_run_id","key")
);
--> statement-breakpoint
CREATE TABLE "log_chunks" (
	"step_run_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"seq" integer NOT NULL,
	"byte_offset" bigint NOT NULL,
	"size" integer NOT NULL,
	"blob_key" text NOT NULL,
	CONSTRAINT "log_chunks_step_run_id_attempt_seq_pk" PRIMARY KEY("step_run_id","attempt","seq")
);
--> statement-breakpoint
CREATE TABLE "runner_join_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"created_by_principal_id" text NOT NULL,
	"used_at" timestamp with time zone,
	"runner_id" text,
	CONSTRAINT "runner_join_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "runners" (
	"id" text PRIMARY KEY NOT NULL,
	"secret_hash" text NOT NULL,
	"secret_prefix" text NOT NULL,
	"desired_state" text DEFAULT 'active' NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"slots" integer NOT NULL,
	"caps_hash" text,
	"capabilities" jsonb,
	"protocol_version" integer,
	"release_version" text,
	"last_heartbeat_at" timestamp with time zone,
	CONSTRAINT "runners_desired_state_check" CHECK ("runners"."desired_state" in ('active', 'draining', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "pipeline_definition_cache" (
	"repository_id" text NOT NULL,
	"path" text NOT NULL,
	"ref" text NOT NULL,
	"content_sha" text NOT NULL,
	"parsed" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_definition_cache_repository_id_path_pk" PRIMARY KEY("repository_id","path")
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"delivery_id" text PRIMARY KEY NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "service_accounts" ADD CONSTRAINT "service_accounts_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_accounts" ADD CONSTRAINT "service_accounts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_principal_id_users_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."users"("principal_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_principal_id_users_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."users"("principal_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_principal_id_users_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."users"("principal_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_app_installations" ADD CONSTRAINT "github_app_installations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_github_app_installation_id_github_app_installations_id_fk" FOREIGN KEY ("github_app_installation_id") REFERENCES "public"."github_app_installations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_owner_principal_id_principals_id_fk" FOREIGN KEY ("owner_principal_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_principal_id_principals_id_fk" FOREIGN KEY ("actor_principal_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_pipeline_repository_id_repositories_id_fk" FOREIGN KEY ("pipeline_repository_id") REFERENCES "public"."repositories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_triggered_by_principal_id_principals_id_fk" FOREIGN KEY ("triggered_by_principal_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_credential_principal_id_principals_id_fk" FOREIGN KEY ("credential_principal_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_parent_run_id_runs_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_run_costs" ADD CONSTRAINT "step_run_costs_step_run_id_step_runs_id_fk" FOREIGN KEY ("step_run_id") REFERENCES "public"."step_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_runs" ADD CONSTRAINT "step_runs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_runs" ADD CONSTRAINT "step_runs_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_step_run_id_step_runs_id_fk" FOREIGN KEY ("step_run_id") REFERENCES "public"."step_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_answered_by_principal_id_users_principal_id_fk" FOREIGN KEY ("answered_by_principal_id") REFERENCES "public"."users"("principal_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_step_run_id_step_runs_id_fk" FOREIGN KEY ("step_run_id") REFERENCES "public"."step_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_authored_by_principal_id_principals_id_fk" FOREIGN KEY ("authored_by_principal_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "log_chunks" ADD CONSTRAINT "log_chunks_step_run_id_step_runs_id_fk" FOREIGN KEY ("step_run_id") REFERENCES "public"."step_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_join_tokens" ADD CONSTRAINT "runner_join_tokens_created_by_principal_id_principals_id_fk" FOREIGN KEY ("created_by_principal_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_join_tokens" ADD CONSTRAINT "runner_join_tokens_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_definition_cache" ADD CONSTRAINT "pipeline_definition_cache_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runs_project_id_id_idx" ON "runs" USING btree ("project_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "runs_project_id_ended_at_id_idx" ON "runs" USING btree ("project_id","ended_at","id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "runs_pipeline_sha_automation_dedup" ON "runs" USING btree ("pipeline_repository_id","pipeline_path","ref_sha") WHERE "runs"."trigger_kind" = 'automation' and "runs"."parent_run_id" is null;--> statement-breakpoint
CREATE INDEX "runs_artifacts_retention_idx" ON "runs" USING btree ("ended_at") WHERE "runs"."artifacts_purged_at" is null;--> statement-breakpoint
CREATE INDEX "runs_logs_retention_idx" ON "runs" USING btree ("ended_at") WHERE "runs"."logs_purged_at" is null;--> statement-breakpoint
CREATE INDEX "runs_branches_retention_idx" ON "runs" USING btree ("ended_at") WHERE "runs"."branches_purged_at" is null;--> statement-breakpoint
CREATE INDEX "step_runs_ready_claim_idx" ON "step_runs" USING btree ("ready_at") WHERE "step_runs"."outcome" = 'ready';--> statement-breakpoint
CREATE INDEX "step_runs_required_tags_gin_idx" ON "step_runs" USING gin ("required_tags");--> statement-breakpoint
CREATE INDEX "step_runs_session_retention_idx" ON "step_runs" USING btree ("run_id") WHERE "step_runs"."session_purged_at" is null and "step_runs"."outcome" <> 'awaiting-human' and "step_runs"."session_blob_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "questions_one_open_per_step_run" ON "questions" USING btree ("step_run_id") WHERE "questions"."answered_at" is null;--> statement-breakpoint
CREATE INDEX "questions_waiting_for_me_idx" ON "questions" USING btree ("created_at") WHERE "questions"."answered_at" is null;--> statement-breakpoint
CREATE INDEX "runners_tags_gin_idx" ON "runners" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_received_at_idx" ON "webhook_deliveries" USING btree ("received_at");