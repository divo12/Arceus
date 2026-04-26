ALTER TABLE "artifacts" DROP CONSTRAINT "artifacts_kind_check";--> statement-breakpoint
ALTER TABLE "meetings" DROP CONSTRAINT "meetings_kind_check";--> statement-breakpoint
ALTER TABLE "meetings" DROP CONSTRAINT "meetings_status_check";--> statement-breakpoint
ALTER TABLE "sprints" DROP CONSTRAINT "sprints_status_check";--> statement-breakpoint
DROP INDEX "sprints_company_number_idx";--> statement-breakpoint
ALTER TABLE "artifacts" ALTER COLUMN "agent_role" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "artifacts" ALTER COLUMN "content" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sprints" ALTER COLUMN "sprint_number" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sprints" ALTER COLUMN "status" SET DEFAULT 'planning';--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "friendly_id" text;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "location" text;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "content_type" text;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "friendly_id" text;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "body" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "facilitator_agent_id" text;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "schedule_id" text;--> statement-breakpoint
ALTER TABLE "sprints" ADD COLUMN "friendly_id" text;--> statement-breakpoint
ALTER TABLE "sprints" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "sprints" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "sprints" ADD COLUMN "strategy_id" text;--> statement-breakpoint
ALTER TABLE "sprints" ADD COLUMN "planned_by_agent_id" text;--> statement-breakpoint
ALTER TABLE "sprints" ADD COLUMN "review_state" jsonb;--> statement-breakpoint
CREATE INDEX "artifacts_friendly_id_idx" ON "artifacts" USING btree ("friendly_id") WHERE "artifacts"."friendly_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "meetings_friendly_id_idx" ON "meetings" USING btree ("friendly_id") WHERE "meetings"."friendly_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "sprints_friendly_id_idx" ON "sprints" USING btree ("friendly_id") WHERE "sprints"."friendly_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "sprints_company_number_idx" ON "sprints" USING btree ("company_id","sprint_number") WHERE "sprints"."sprint_number" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_kind_check" CHECK ("artifacts"."kind" IN ('architecture', 'specification', 'implementation', 'preview', 'qa_report', 'launch_asset', 'meeting_note', 'chat_card', 'memory_seed', 'plan', 'output', 'handoff', 'other', 'code', 'design', 'report', 'campaign', 'test', 'spec'));--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_kind_check" CHECK ("meetings"."kind" IN ('daily_sync', 'eval_triggered', 'escalation', 'sprint_planning', 'retro', 'decision', 'ad_hoc', 'in_progress', 'cancelled'));--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_status_check" CHECK ("meetings"."status" IN ('scheduled', 'collecting', 'synthesizing', 'resolving', 'executing', 'learning', 'completed', 'skipped', 'in_progress', 'cancelled'));--> statement-breakpoint
ALTER TABLE "sprints" ADD CONSTRAINT "sprints_status_check" CHECK ("sprints"."status" IN ('planning', 'executing', 'reviewing', 'completed', 'between_sprints', 'paused', 'cancelled', 'planned', 'active'));