-- Migration 005: Policy Governance Gateway (Spec 13 – Phase 1)
-- Creates trust_scores and policy_violations tables.

BEGIN;

-- ── Trust Scores ────────────────────────────────────────────
-- One row per agent. Tracks current trust factor and adjustment history.

CREATE TABLE IF NOT EXISTS hippocampus.trust_scores (
  agent_id   TEXT PRIMARY KEY,
  score      REAL NOT NULL DEFAULT 0.7,
  history    JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Policy Violations ───────────────────────────────────────
-- Audit log of every policy violation or escalation event.

CREATE TABLE IF NOT EXISTS hippocampus.policy_violations (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  rule_id     TEXT NOT NULL,
  tool        TEXT NOT NULL,
  decision    TEXT NOT NULL,
  severity    TEXT NOT NULL DEFAULT 'medium',
  detail      TEXT NOT NULL DEFAULT '',
  beat_id     TEXT,
  resolved_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Agent lookup: all violations by agent
CREATE INDEX IF NOT EXISTS idx_policy_violations_agent
  ON hippocampus.policy_violations (agent_id, created_at DESC);

-- Company-wide violations, newest first
CREATE INDEX IF NOT EXISTS idx_policy_violations_company
  ON hippocampus.policy_violations (company_id, created_at DESC);

-- Unresolved violations
CREATE INDEX IF NOT EXISTS idx_policy_violations_unresolved
  ON hippocampus.policy_violations (company_id)
  WHERE resolved_at IS NULL;

COMMIT;
