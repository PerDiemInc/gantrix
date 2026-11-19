CREATE TABLE "project_discussion" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"task_id" uuid NOT NULL,
	"role" text NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_discussion_role_valid" CHECK ("project_discussion"."role" in ('user', 'owner'))
);
--> statement-breakpoint
ALTER TABLE "project_discussion" ADD CONSTRAINT "project_discussion_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_discussion_task_idx" ON "project_discussion" USING btree ("task_id","created_at");