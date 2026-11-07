CREATE TABLE "delegations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"task_id" uuid NOT NULL,
	"step_id" uuid NOT NULL,
	"interrupt_id" text NOT NULL,
	"child_step_id" uuid,
	"status" text DEFAULT 'running' NOT NULL,
	"answer" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "steps" DROP CONSTRAINT "steps_status_valid";--> statement-breakpoint
ALTER TABLE "steps" ADD COLUMN "parent_step_id" uuid;--> statement-breakpoint
ALTER TABLE "delegations" ADD CONSTRAINT "delegations_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegations" ADD CONSTRAINT "delegations_step_id_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."steps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegations" ADD CONSTRAINT "delegations_child_step_id_steps_id_fk" FOREIGN KEY ("child_step_id") REFERENCES "public"."steps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delegations_step_interrupt_idx" ON "delegations" USING btree ("step_id","interrupt_id");--> statement-breakpoint
CREATE INDEX "delegations_task_status_idx" ON "delegations" USING btree ("task_id","status");--> statement-breakpoint
ALTER TABLE "steps" ADD CONSTRAINT "steps_status_valid" CHECK (status in ('pending', 'queued', 'running', 'awaiting_approval', 'delegating', 'judging', 'succeeded', 'failed', 'superseded', 'cancelled'));