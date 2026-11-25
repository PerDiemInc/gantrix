ALTER TABLE "agents" ADD COLUMN "github_connection_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "setup" jsonb;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_github_connection_id_connections_id_fk" FOREIGN KEY ("github_connection_id") REFERENCES "public"."connections"("id") ON DELETE set null ON UPDATE no action;