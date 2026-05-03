-- Spec 31 PR #13d — canonical `public.habits` table for the procedural
-- memory store. Closes the spec gap that made PR #13c "memory_units only"
-- (no canonical habits existed, so the procedural backend stayed on
-- legacy). Pure DDL: safe to apply on a populated DB; backfill from
-- `hippocampus.habits` runs out-of-band via `db:backfill-habits`.
CREATE TABLE "habits" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "trigger_condition" text NOT NULL,
  "action" text NOT NULL,
  "confidence" real NOT NULL DEFAULT 0.0,
  "usage_count" integer NOT NULL DEFAULT 0,
  "formed_from_id" text NOT NULL DEFAULT '',
  "formation_mode" text NOT NULL DEFAULT 'auto',
  "is_active" boolean NOT NULL DEFAULT true,
  "legacy_id" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "habits_confidence_check"     CHECK ("confidence"     >= 0.0 AND "confidence" <= 1.0),
  CONSTRAINT "habits_usage_count_check"    CHECK ("usage_count"    >= 0),
  CONSTRAINT "habits_formation_mode_check" CHECK ("formation_mode" IN ('auto','explicit'))
);--> statement-breakpoint
-- Hot path: list active habits for an agent (matches legacy
-- `idx_habits_agent`).
CREATE INDEX "habits_agent_active_idx" ON "habits" ("agent_id") WHERE "is_active" = true;--> statement-breakpoint
-- GC + admin: walk every habit for a company.
CREATE INDEX "habits_company_idx" ON "habits" ("company_id");--> statement-breakpoint
-- Backfill idempotency: matches the `memory_units.legacy_id` pattern
-- so re-runs collapse via ON CONFLICT.
CREATE UNIQUE INDEX "habits_legacy_id_idx" ON "habits" ("legacy_id") WHERE "legacy_id" IS NOT NULL;
