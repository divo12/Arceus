-- Spec 31 Phase 7.B.7 (A1) — restore the `snapshot_data` column on
-- `sprint_snapshots` so the canonical schema can carry the
-- frozen-at-tag CompanySnapshot blob that the SprintSnapshot contract
-- requires.
--
-- The original 0000 migration omitted this column on the assumption
-- that snapshot state could be reconstructed from FK-linked rows on
-- demand. That breaks the rollback guarantee — "rolling back to sprint
-- 3" must return the state *as of sprint 3 completion*, not the
-- current state of tasks/agents/etc. Without the column, rollback
-- semantics drift any time downstream rows mutate.
--
-- IF NOT EXISTS makes the migration idempotent against legacy
-- databases that retained the column from the pre-spec-31 bootstrap.
-- The default `'{}'::jsonb` lets the NOT NULL constraint apply
-- without a backfill — pre-existing rows (none on canonical, possibly
-- present on legacy dbs) get an empty snapshot until the next
-- `tagSprint` overwrites them.

ALTER TABLE "sprint_snapshots"
  ADD COLUMN IF NOT EXISTS "snapshot_data" jsonb NOT NULL DEFAULT '{}'::jsonb;
