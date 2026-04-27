-- Spec 31 PR #13c — add the dynamic-store columns the legacy backend
-- relies on (relevance decay, soft-delete, version bump) so the
-- pgvector backend can read from `public.memory_units` without losing
-- behaviour. Pure DDL: defaults make the migration safe on populated
-- tables; no row rewrite (Postgres 11+ stores defaults in pg_attribute).
ALTER TABLE "memory_units" ADD COLUMN "relevance_score" real NOT NULL DEFAULT 1.0;--> statement-breakpoint
ALTER TABLE "memory_units" ADD COLUMN "container" text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE "memory_units" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memory_units" ADD COLUMN "delete_reason" text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE "memory_units" ADD COLUMN "version" integer NOT NULL DEFAULT 1;--> statement-breakpoint
-- Partial index: every hot read filters `deleted_at IS NULL` so the
-- index excludes tombstones to keep it tight. Same shape as the
-- legacy `idx_memory_agent_type` so plans don't regress on flip.
CREATE INDEX "memory_units_agent_type_live_idx" ON "memory_units" USING btree ("agent_id","type") WHERE "deleted_at" IS NULL;--> statement-breakpoint
-- GC path: find expired temporal facts efficiently.
CREATE INDEX "memory_units_expires_live_idx" ON "memory_units" USING btree ("expires_at") WHERE "expires_at" IS NOT NULL AND "deleted_at" IS NULL;
