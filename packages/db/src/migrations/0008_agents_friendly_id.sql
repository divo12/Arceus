-- Migration 0008: add agents.friendly_id (Spec 31 Phase 5).
-- The schema.ts column was added without a corresponding SQL migration,
-- causing every persistAgents() to fail with pg=42703 ("column friendly_id
-- does not exist"). That in turn left agents rows missing in the DB, so
-- task inserts that reference assigned_agent_id failed with FK 23503,
-- which made the CTO heartbeat path fail to find its claimed task.
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "friendly_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agents_friendly_id_idx"
  ON "agents" ("friendly_id")
  WHERE "friendly_id" IS NOT NULL;
