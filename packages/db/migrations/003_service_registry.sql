-- Migration 003: Service Registry Table (Spec 11 Phase 3 – Control Plane)
-- Tracks tools available per role with blast-radius classification and version tracking.

BEGIN;

CREATE TABLE IF NOT EXISTS hippocampus.service_registry (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL,
  tool_name     TEXT NOT NULL,
  description   TEXT NOT NULL,
  allowed_roles TEXT[] NOT NULL,
  blast_radius  TEXT NOT NULL DEFAULT 'green',
  requires_approval BOOLEAN NOT NULL DEFAULT false,
  parameters    JSONB NOT NULL DEFAULT '[]',
  source        TEXT NOT NULL DEFAULT 'system',
  version       INTEGER NOT NULL DEFAULT 1,
  added_by      TEXT NOT NULL DEFAULT 'system',
  added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(company_id, tool_name)
);

-- Lookup by company
CREATE INDEX IF NOT EXISTS idx_service_registry_company
  ON hippocampus.service_registry (company_id);

-- Lookup by role (GIN on array column)
CREATE INDEX IF NOT EXISTS idx_service_registry_roles
  ON hippocampus.service_registry USING GIN (allowed_roles);

COMMIT;
