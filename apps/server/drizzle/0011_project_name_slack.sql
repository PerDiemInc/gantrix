ALTER TABLE "tasks" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "slack" boolean DEFAULT false NOT NULL;