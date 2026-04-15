-- Migration 007: Skill Artifacts (Spec 14 – Phase 1)
-- Versioned, mutable skill artifacts for the self-evolution pipeline.

BEGIN;

-- ── Skill Artifacts ────────────────────────────────────────
-- Versioned skill records. Each version is a separate row.
-- status: draft → testing → active → deprecated

CREATE TABLE IF NOT EXISTS hippocampus.skill_artifacts (
  id               TEXT PRIMARY KEY,
  company_id       TEXT NOT NULL,
  name             TEXT NOT NULL,
  role             TEXT NOT NULL,
  version          INTEGER NOT NULL DEFAULT 1,
  status           TEXT NOT NULL DEFAULT 'draft',
  trigger_condition TEXT NOT NULL,
  content          TEXT NOT NULL,
  test_cases       JSONB NOT NULL DEFAULT '[]',
  success_rate     REAL NOT NULL DEFAULT 0.5,
  usage_count      INTEGER NOT NULL DEFAULT 0,
  last_used_at     TIMESTAMPTZ,
  mutated_from_id  TEXT REFERENCES hippocampus.skill_artifacts(id),
  mutated_by       TEXT,
  mutation_reason  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at      TIMESTAMPTZ,
  UNIQUE(company_id, name, version)
);

CREATE INDEX IF NOT EXISTS idx_skills_role
  ON hippocampus.skill_artifacts(company_id, role, status);

CREATE INDEX IF NOT EXISTS idx_skills_active
  ON hippocampus.skill_artifacts(company_id, status)
  WHERE status = 'active';

-- ── Skill Mutations ────────────────────────────────────────
-- Tracks proposed skill changes through the ATA pipeline.
-- Phase 2+ will use this; creating now for schema completeness.

CREATE TABLE IF NOT EXISTS hippocampus.skill_mutations (
  id                TEXT PRIMARY KEY,
  company_id        TEXT NOT NULL,
  original_skill_id TEXT REFERENCES hippocampus.skill_artifacts(id),
  proposed_skill_id TEXT NOT NULL REFERENCES hippocampus.skill_artifacts(id),
  reason            TEXT NOT NULL,
  failure_trace_id  TEXT,
  status            TEXT NOT NULL DEFAULT 'proposed',
  revision_cycle    INTEGER NOT NULL DEFAULT 0,
  test_results      JSONB NOT NULL DEFAULT '[]',
  review_feedback   TEXT,
  proposed_by       TEXT NOT NULL,
  proposed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_mutations_status
  ON hippocampus.skill_mutations(company_id, status);

-- ── Review Findings ────────────────────────────────────────
-- Automated code review results per task (Phase 4).

CREATE TABLE IF NOT EXISTS hippocampus.review_findings (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL,
  task_id         TEXT NOT NULL,
  sprint_id       TEXT,
  agent_role      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pass',
  findings        JSONB NOT NULL DEFAULT '[]',
  skill_violations JSONB NOT NULL DEFAULT '[]',
  total_findings  INTEGER NOT NULL DEFAULT 0,
  critical_count  INTEGER NOT NULL DEFAULT 0,
  reviewed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reviews_task
  ON hippocampus.review_findings(company_id, task_id);

CREATE INDEX IF NOT EXISTS idx_reviews_critical
  ON hippocampus.review_findings(company_id)
  WHERE critical_count > 0;

COMMIT;
