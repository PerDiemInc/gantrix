CREATE TABLE "task_env" (
	"task_id" uuid PRIMARY KEY NOT NULL,
	"vars" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "step_timeout_minutes" real;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "live_check" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "shell_env_names" text[];--> statement-breakpoint
ALTER TABLE "task_env" ADD CONSTRAINT "task_env_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_step_timeout_positive" CHECK ("agents"."step_timeout_minutes" is null or "agents"."step_timeout_minutes" > 0);