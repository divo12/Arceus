-- Spec 31 Phase 7 — drop the legacy hippocampus schema and the
-- `legacy_id` bridge columns that PR #13a/#13d added for the cutover.
--
-- The runtime backend (`packages/hippocampus/src/backends/pgvector.ts`)
-- now reads exclusively from canonical tables since PR #13c/#13d, and
-- the bridge columns + one-shot backfill scripts have been deleted in
-- this PR. Once this migration runs, the legacy schema is gone for
-- good — there is no rollback.
DROP INDEX IF EXISTS "memory_units_legacy_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "habits_legacy_id_idx";--> statement-breakpoint
ALTER TABLE "memory_units" DROP COLUMN IF EXISTS "legacy_id";--> statement-breakpoint
ALTER TABLE "habits"       DROP COLUMN IF EXISTS "legacy_id";--> statement-breakpoint
-- CASCADE drops `hippocampus.memory_units`, `hippocampus.habits`,
-- `hippocampus.priming_state`, `hippocampus.audit_events`, and any
-- indexes/triggers under the schema.
DROP SCHEMA IF EXISTS "hippocampus" CASCADE;
