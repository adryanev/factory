CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"principal_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_principal_id_users_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."users"("principal_id") ON DELETE no action ON UPDATE no action;