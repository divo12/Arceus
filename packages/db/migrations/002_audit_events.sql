-- Migration 002: Audit Events Table (Spec 11 – Control Plane)
-- Append-only log for all system, agent, task, and error events.

BEGIN;

CREATE TABLE IF NOT EXISTS hippocampus.audit_events (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL,
  sequence      INTEGER NOT NULL,
  category      TEXT NOT NULL,
  severity      TEXT NOT NULL DEFAULT 'info',
  event_type    TEXT NOT NULL,
  agent_id      TEXT,
  agent_role    TEXT,
  summary       TEXT NOT NULL,
  detail        JSONB,
  correlation_id TEXT,
  causation_id  TEXT,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Query by company + time (most common read path)
CREATE INDEX IF NOT EXISTS idx_audit_events_company_time
  ON hippocampus.audit_events (company_id, occurred_at DESC);

-- Filter by category
CREATE INDEX IF NOT EXISTS idx_audit_events_category
  ON hippocampus.audit_events (category, occurred_at DESC);

-- Correlation chain lookups
CREATE INDEX IF NOT EXISTS idx_audit_events_correlation
  ON hippocampus.audit_events (correlation_id)
  WHERE correlation_id IS NOT NULL;

COMMIT;
