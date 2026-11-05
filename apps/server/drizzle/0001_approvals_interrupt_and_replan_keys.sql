ALTER TABLE "steps" DROP CONSTRAINT "steps_task_key_key";--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "interrupt_id" text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "steps_task_key_active_idx" ON "steps" USING btree ("task_id","key") WHERE "steps"."status" <> 'superseded';--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_step_interrupt_key" UNIQUE("step_id","interrupt_id");