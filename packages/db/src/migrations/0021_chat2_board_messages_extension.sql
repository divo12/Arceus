-- Spec 35 — CEO Chat 2.0 — extend board_messages with mode, parent_message_id,
-- and card decision tracking. Card-type enum is widened by adding the new
-- contracts cardTypes (idea_refine, name_suggest, hiring_slate, sprint_plan,
-- decision, meeting_summary, memory_capture).
--
-- Other DDL drizzle-kit emitted (skill_mutations, sprint_snapshots.snapshot_data)
-- was stripped — those tables/columns were created by hand-written migrations
-- 0018/0019 and are already present; the snapshot just hadn't caught up.

ALTER TABLE "board_messages" DROP CONSTRAINT IF EXISTS "board_messages_card_type_check";--> statement-breakpoint
ALTER TABLE "board_messages" ADD COLUMN IF NOT EXISTS "mode" text;--> statement-breakpoint
ALTER TABLE "board_messages" ADD COLUMN IF NOT EXISTS "parent_message_id" uuid;--> statement-breakpoint
ALTER TABLE "board_messages" ADD COLUMN IF NOT EXISTS "card_decision" jsonb;--> statement-breakpoint
ALTER TABLE "board_messages" ADD COLUMN IF NOT EXISTS "card_decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "board_messages" ADD COLUMN IF NOT EXISTS "card_decided_by" text;--> statement-breakpoint
ALTER TABLE "board_messages" ADD CONSTRAINT "board_messages_parent_message_id_board_messages_id_fk" FOREIGN KEY ("parent_message_id") REFERENCES "public"."board_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "board_messages_parent_idx" ON "board_messages" USING btree ("parent_message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "board_messages_company_card_pending_idx" ON "board_messages" USING btree ("company_id","card_decided_at") WHERE "board_messages"."card_type" IS NOT NULL AND "board_messages"."card_decided_at" IS NULL;--> statement-breakpoint
ALTER TABLE "board_messages" ADD CONSTRAINT "board_messages_mode_check" CHECK ("board_messages"."mode" IS NULL OR "board_messages"."mode" IN ('ask', 'instruct', 'store'));--> statement-breakpoint
ALTER TABLE "board_messages" ADD CONSTRAINT "board_messages_card_type_check" CHECK ("board_messages"."card_type" IS NULL OR "board_messages"."card_type" IN ('welcome_brief', 'mission_brief', 'strategy_proposal', 'clarifying_question', 'status_update', 'sprint_proposal', 'review_summary', 'approval_request', 'daily_sync_summary', 'info', 'idea_refine', 'name_suggest', 'hiring_slate', 'sprint_plan', 'decision', 'meeting_summary', 'memory_capture'));
