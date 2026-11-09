ALTER TABLE "tasks" ADD COLUMN "offload_connection_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "paused_ms" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_offload_connection_id_connections_id_fk" FOREIGN KEY ("offload_connection_id") REFERENCES "public"."connections"("id") ON DELETE set null ON UPDATE no action;