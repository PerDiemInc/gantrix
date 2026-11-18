-- Idempotent: an earlier local build shipped these changes as 0016_deploy_until_done.
CREATE TABLE IF NOT EXISTS "task_env" (
	"task_id" uuid PRIMARY KEY NOT NULL,
	"vars" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "step_timeout_minutes" real;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "live_check" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "shell_env_names" text[];--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "task_env" ADD CONSTRAINT "task_env_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "agents" ADD CONSTRAINT "agents_step_timeout_positive" CHECK ("agents"."step_timeout_minutes" is null or "agents"."step_timeout_minutes" > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
