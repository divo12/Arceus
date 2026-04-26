-- Spec 31 Phase 4A: idempotent re-drop. Cofounder's `008_drop_service_registry.sql`
-- already dropped this table on local + Supabase; re-running with `IF EXISTS`
-- so any environment that missed the manual migration converges here.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'service_registry') THEN
    EXECUTE 'ALTER TABLE "service_registry" DISABLE ROW LEVEL SECURITY';
    EXECUTE 'DROP TABLE "service_registry" CASCADE';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "companies" DROP CONSTRAINT "companies_status_check";--> statement-breakpoint
DROP INDEX "companies_slug_idx";--> statement-breakpoint
DROP INDEX "companies_task_prefix_idx";--> statement-breakpoint
ALTER TABLE "companies" ALTER COLUMN "slug" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ALTER COLUMN "board_owner_email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ALTER COLUMN "task_prefix" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "companies" ALTER COLUMN "task_prefix" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "friendly_id" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "board_owner" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "budget_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "spent_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "current_strategy_id" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "current_sprint_id" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "current_sprint_number" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "companies_friendly_id_idx" ON "companies" USING btree ("friendly_id") WHERE "companies"."friendly_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "companies_slug_idx" ON "companies" USING btree ("slug") WHERE "companies"."slug" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "companies_task_prefix_idx" ON "companies" USING btree ("task_prefix") WHERE "companies"."task_prefix" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_status_check" CHECK ("companies"."status" IN ('ideation','active','paused','archived'));