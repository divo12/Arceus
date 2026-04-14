-- Migration 004: Heartbeat Scheduling Engine (Spec 12 – Phase 1)
-- Creates beat_records table, adds beat_id to audit_events, adds snapshot_version to company_states.

BEGIN;

-- ── Beat Records ────────────────────────────────────────────
-- One row per heartbeat cycle. Links to audit_events via beat_id.

CREATE TABLE IF NOT EXISTS hippocampus.beat_records (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL,
  agent_id        TEXT,
  beat_number     INTEGER NOT NULL,
  trigger         JSONB NOT NULL,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at        TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'running',
  snapshot_version_read    INTEGER,
  snapshot_version_written INTEGER,
  phases          JSONB NOT NULL DEFAULT '{}',
  outcome         TEXT,
  total_tokens    INTEGER NOT NULL DEFAULT 0,
  cost_cents      NUMERIC(12,4) NOT NULL DEFAULT 0,
  error_message   TEXT,
  summary         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Primary query: beats for agent in a company, newest first
CREATE INDEX IF NOT EXISTS idx_beat_records_company_agent
  ON hippocampus.beat_records (company_id, agent_id, started_at DESC);

-- Beat number ordering per company
CREATE INDEX IF NOT EXISTS idx_beat_records_company_number
  ON hippocampus.beat_records (company_id, beat_number DESC);

-- Find running beats (concurrency check)
CREATE INDEX IF NOT EXISTS idx_beat_records_running
  ON hippocampus.beat_records (status)
  WHERE status = 'running';

-- ── Audit Events: add beat_id column ────────────────────────

ALTER TABLE hippocampus.audit_events
  ADD COLUMN IF NOT EXISTS beat_id TEXT;

CREATE INDEX IF NOT EXISTS idx_audit_events_beat
  ON hippocampus.audit_events (beat_id)
  WHERE beat_id IS NOT NULL;

-- ── Company States: add snapshot_version column ─────────────

ALTER TABLE hippocampus.company_states
  ADD COLUMN IF NOT EXISTS snapshot_version INTEGER NOT NULL DEFAULT 0;

COMMIT;
