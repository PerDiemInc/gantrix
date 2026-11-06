CREATE TABLE "task_messages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"task_id" uuid NOT NULL,
	"step_id" uuid,
	"text" text NOT NULL,
	"delivered_at" timestamp with time zone,
	"plan_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_messages" ADD CONSTRAINT "task_messages_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_messages" ADD CONSTRAINT "task_messages_step_id_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."steps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_messages_task_idx" ON "task_messages" USING btree ("task_id","created_at");