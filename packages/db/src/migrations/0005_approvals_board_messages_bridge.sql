ALTER TABLE "approvals" DROP CONSTRAINT "approvals_status_check";--> statement-breakpoint
ALTER TABLE "board_messages" DROP CONSTRAINT "board_messages_direction_check";--> statement-breakpoint
ALTER TABLE "approvals" ALTER COLUMN "payload" SET DEFAULT '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "board_messages" ALTER COLUMN "direction" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "board_messages" ALTER COLUMN "sender" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "friendly_id" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "meeting_id" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "agenda_item_id" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "resolution_summary" text;--> statement-breakpoint
ALTER TABLE "board_messages" ADD COLUMN "friendly_id" text;--> statement-breakpoint
ALTER TABLE "board_messages" ADD COLUMN "role" text;--> statement-breakpoint
ALTER TABLE "board_messages" ADD COLUMN "sprint_id" text;--> statement-breakpoint
ALTER TABLE "board_messages" ADD COLUMN "agent_id" text;--> statement-breakpoint
ALTER TABLE "board_messages" ADD COLUMN "card_type" text;--> statement-breakpoint
ALTER TABLE "board_messages" ADD COLUMN "card_data" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_friendly_id_idx" ON "approvals" USING btree ("friendly_id") WHERE "approvals"."friendly_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "board_messages_company_role_created_idx" ON "board_messages" USING btree ("company_id","role","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "board_messages_friendly_id_idx" ON "board_messages" USING btree ("friendly_id") WHERE "board_messages"."friendly_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_status_check" CHECK ("approvals"."status" IN ('pending', 'approved', 'rejected', 'applied', 'expired'));--> statement-breakpoint
ALTER TABLE "board_messages" ADD CONSTRAINT "board_messages_role_check" CHECK ("board_messages"."role" IS NULL OR "board_messages"."role" IN ('board', 'ceo', 'agent', 'system'));--> statement-breakpoint
ALTER TABLE "board_messages" ADD CONSTRAINT "board_messages_card_type_check" CHECK ("board_messages"."card_type" IS NULL OR "board_messages"."card_type" IN ('welcome_brief', 'mission_brief', 'strategy_proposal', 'clarifying_question', 'status_update', 'sprint_proposal', 'review_summary', 'approval_request', 'daily_sync_summary', 'info'));--> statement-breakpoint
ALTER TABLE "board_messages" ADD CONSTRAINT "board_messages_direction_check" CHECK ("board_messages"."direction" IS NULL OR "board_messages"."direction" IN ('inbound','outbound'));