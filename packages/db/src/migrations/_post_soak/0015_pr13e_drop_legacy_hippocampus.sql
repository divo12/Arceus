-- Spec 31 PR #13e — destructive drop of the legacy hippocampus schema.
--
-- ⚠ NOT in the regular migrations directory.  This file is staged
--   here so it doesn't run on `bun run --cwd packages/db db:migrate`
--   until the operator explicitly promotes it.
--
-- Apply ONLY after:
--   1. PR #13c memory_units flip has soaked ≥3 days in dev with the
--      new backend serving 100% of memory reads.
--   2. PR #13d habits + priming flip has soaked ≥3 days similarly.
--   3. Backfill scripts have been run and validated to row-count
--      parity:
--        - bun run --cwd packages/db db:backfill-memory --run
--        - bun run --cwd packages/db db:backfill-memory-dynamic --run
--        - bun run --cwd packages/db db:backfill-habits --run
--        - bun run --cwd packages/db db:backfill-priming --run
--   4. Activity log review for the soak window shows zero queries
--      hitting `hippocampus.*` from the runtime backend (legacy reads
--      stopped).
--
-- Promote by moving this file up one directory + adding a journal
-- entry, then run `db:migrate` once. There is no rollback — the
-- legacy schema and its data are permanently destroyed by CASCADE.
BEGIN;

-- 1. Drop the bridge column. After PR #13c+#13d soak, no consumer
--    references it; the unique partial index goes with it.
ALTER TABLE "memory_units" DROP COLUMN "legacy_id";
ALTER TABLE "habits"       DROP COLUMN "legacy_id";

-- 2. Tear down the legacy schema. CASCADE drops:
--      hippocampus.memory_units
--      hippocampus.habits
--      hippocampus.priming_state
--      hippocampus.audit_events
--    plus their indexes and triggers.
DROP SCHEMA "hippocampus" CASCADE;

COMMIT;
