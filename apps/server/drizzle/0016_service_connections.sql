ALTER TABLE "connections" DROP CONSTRAINT "connections_provider_valid";--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_provider_valid" CHECK (provider in ('ollama', 'openai', 'anthropic', 'claude-code', 'codex', 'http', 'github', 'slack'));