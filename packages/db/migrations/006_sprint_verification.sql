-- Migration 006: Sprint Verification & QA Framework (Spec 21)
-- Adds review_state JSONB column to track sprint verification phase.

BEGIN;

-- Sprint review state — stores SprintReviewState JSON during the reviewing phase.
-- NULL when sprint is not in review. Populated when sprint enters "reviewing" status.
ALTER TABLE hippocampus.company_states
  ADD COLUMN IF NOT EXISTS _placeholder_006 TEXT;

-- Note: sprints live inside company_states.snapshot_data JSONB, not a separate table.
-- The reviewState field is added to the Sprint type in domain.ts and will be
-- persisted as part of the snapshot_data JSONB. No schema migration needed
-- beyond the domain type change — Drizzle stores the full snapshot as JSONB.

-- Drop the placeholder (used only to ensure migration is idempotent)
ALTER TABLE hippocampus.company_states
  DROP COLUMN IF EXISTS _placeholder_006;

COMMIT;
