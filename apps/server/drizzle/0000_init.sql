CREATE TABLE "agent_skills" (
	"agent_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	CONSTRAINT "agent_skills_agent_id_skill_id_pk" PRIMARY KEY("agent_id","skill_id")
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"system_prompt" text DEFAULT '' NOT NULL,
	"model" text,
	"model_base_url" text,
	"connection_id" uuid,
	"slack_connection_id" uuid,
	"max_concurrency" integer DEFAULT 1 NOT NULL,
	"step_timeout_minutes" real,
	"avatar" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_name_unique" UNIQUE("name"),
	CONSTRAINT "agents_max_concurrency_positive" CHECK ("agents"."max_concurrency" > 0),
	CONSTRAINT "agents_step_timeout_positive" CHECK ("agents"."step_timeout_minutes" is null or "agents"."step_timeout_minutes" > 0)
);
--> statement-breakpoint
CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"task_id" uuid NOT NULL,
	"step_id" uuid NOT NULL,
	"interrupt_id" text NOT NULL,
	"tool" text NOT NULL,
	"args" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"answer" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "approvals_step_interrupt_key" UNIQUE("step_id","interrupt_id"),
	CONSTRAINT "approvals_status_valid" CHECK (status in ('pending', 'approved', 'denied'))
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"base_url" text,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"request" jsonb,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connections_name_unique" UNIQUE("name"),
	CONSTRAINT "connections_provider_valid" CHECK (provider in ('ollama', 'openai', 'anthropic', 'claude-code', 'codex', 'http', 'github', 'slack'))
);
--> statement-breakpoint
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
CREATE TABLE "events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"task_id" uuid NOT NULL,
	"step_id" uuid,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"goal" text NOT NULL,
	"steps" jsonb NOT NULL,
	"schedule" text,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"budget" jsonb,
	"approve_all" boolean,
	"slack" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"task_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_task_version_key" UNIQUE("task_id","version")
);
--> statement-breakpoint
CREATE TABLE "project_discussion" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"task_id" uuid NOT NULL,
	"role" text NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_discussion_role_valid" CHECK ("project_discussion"."role" in ('user', 'owner'))
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"version" text NOT NULL,
	"description" text NOT NULL,
	"source_path" text NOT NULL,
	"checksum" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"source_url" text,
	"source_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skills_name_version_key" UNIQUE("name","version")
);
--> statement-breakpoint
CREATE TABLE "steps" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"task_id" uuid NOT NULL,
	"plan_version" integer NOT NULL,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"instructions" text NOT NULL,
	"acceptance" text NOT NULL,
	"agent_id" uuid,
	"parent_step_id" uuid,
	"depends_on" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"output" text,
	"judge_reason" text,
	"error" text,
	"tokens_used" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"queued_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "steps_status_valid" CHECK (status in ('pending', 'queued', 'running', 'awaiting_approval', 'delegating', 'judging', 'succeeded', 'failed', 'superseded', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "task_env" (
	"task_id" uuid PRIMARY KEY NOT NULL,
	"vars" jsonb NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"goal" text NOT NULL,
	"name" text,
	"slack" boolean DEFAULT false NOT NULL,
	"slack_channel" text,
	"slack_thread_ts" text,
	"description" text,
	"status" text DEFAULT 'planning' NOT NULL,
	"budget" jsonb NOT NULL,
	"tokens_used" integer DEFAULT 0 NOT NULL,
	"replans" integer DEFAULT 0 NOT NULL,
	"workspace_path" text NOT NULL,
	"approve_all" boolean DEFAULT false NOT NULL,
	"agent_ids" uuid[],
	"agent_models" jsonb,
	"offload_connection_id" uuid,
	"live_check" boolean DEFAULT false NOT NULL,
	"shell_env_names" text[],
	"job_id" uuid,
	"paused_ms" bigint DEFAULT 0 NOT NULL,
	"result" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "tasks_status_valid" CHECK (status in ('planning', 'running', 'awaiting_approval', 'succeeded', 'failed', 'needs_attention', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_slack_connection_id_connections_id_fk" FOREIGN KEY ("slack_connection_id") REFERENCES "public"."connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_step_id_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."steps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegations" ADD CONSTRAINT "delegations_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegations" ADD CONSTRAINT "delegations_step_id_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."steps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegations" ADD CONSTRAINT "delegations_child_step_id_steps_id_fk" FOREIGN KEY ("child_step_id") REFERENCES "public"."steps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_discussion" ADD CONSTRAINT "project_discussion_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "steps" ADD CONSTRAINT "steps_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "steps" ADD CONSTRAINT "steps_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_env" ADD CONSTRAINT "task_env_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_messages" ADD CONSTRAINT "task_messages_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_messages" ADD CONSTRAINT "task_messages_step_id_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."steps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_offload_connection_id_connections_id_fk" FOREIGN KEY ("offload_connection_id") REFERENCES "public"."connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approvals_pending_idx" ON "approvals" USING btree ("task_id") WHERE "approvals"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "delegations_step_interrupt_idx" ON "delegations" USING btree ("step_id","interrupt_id");--> statement-breakpoint
CREATE INDEX "delegations_task_status_idx" ON "delegations" USING btree ("task_id","status");--> statement-breakpoint
CREATE INDEX "events_task_id_idx" ON "events" USING btree ("task_id","id");--> statement-breakpoint
CREATE INDEX "project_discussion_task_idx" ON "project_discussion" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "steps_task_key_active_idx" ON "steps" USING btree ("task_id","key") WHERE "steps"."status" <> 'superseded';--> statement-breakpoint
CREATE INDEX "steps_task_status_idx" ON "steps" USING btree ("task_id","status");--> statement-breakpoint
CREATE INDEX "task_messages_task_idx" ON "task_messages" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "tasks_created_at_idx" ON "tasks" USING btree ("created_at" DESC NULLS LAST);