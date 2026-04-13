-- Migration 001: Hippocampus Memory Tables (Spec 05a)
-- Depends on: pgvector extension
-- Creates: memory_units, habits, priming_state + indexes + triggers

BEGIN;

-- Enable pgvector if not already enabled
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================
-- Table: memory_units
-- Core storage for static + dynamic agent memories with vector embeddings
-- ============================================================
CREATE TABLE IF NOT EXISTS memory_units (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding vector(384),
  memory_type TEXT NOT NULL DEFAULT 'dynamic'
    CHECK (memory_type IN ('static', 'dynamic')),
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0.0
    CHECK (confidence >= 0.0 AND confidence <= 1.0),
  relevance_score DOUBLE PRECISION NOT NULL DEFAULT 1.0
    CHECK (relevance_score >= 0.0),
  container TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'task_scoped', 'shared', 'board')),
  source_type TEXT
    CHECK (source_type IS NULL OR source_type IN ('task', 'meeting', 'delegation', 'system')),
  source_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1
    CHECK (version >= 1),
  previous_version_id TEXT REFERENCES memory_units(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  delete_reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Ensure source_type and source_id are set together
  CHECK (
    (source_type IS NULL AND source_id IS NULL) OR
    (source_type IS NOT NULL AND source_id IS NOT NULL)
  )
);

-- Primary query: find relevant memories for an agent by embedding similarity
-- Partial index excludes soft-deleted rows from HNSW graph
CREATE INDEX IF NOT EXISTS idx_memory_embedding
  ON memory_units USING hnsw (embedding vector_cosine_ops)
  WHERE deleted_at IS NULL;

-- Pre-filter index for agent + type before vector search
CREATE INDEX IF NOT EXISTS idx_memory_agent_type
  ON memory_units (agent_id, memory_type)
  WHERE deleted_at IS NULL;

-- Container-scoped retrieval for delegation memory sharing
CREATE INDEX IF NOT EXISTS idx_memory_container
  ON memory_units (container)
  WHERE deleted_at IS NULL;

-- Company-wide queries (admin, cross-agent, GC)
CREATE INDEX IF NOT EXISTS idx_memory_company
  ON memory_units (company_id);

-- GC: find expired temporal facts efficiently
CREATE INDEX IF NOT EXISTS idx_memory_expires
  ON memory_units (expires_at)
  WHERE expires_at IS NOT NULL AND deleted_at IS NULL;

-- Auto-update updated_at on row modification
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_memory_units_updated_at ON memory_units;
CREATE TRIGGER trg_memory_units_updated_at
  BEFORE UPDATE ON memory_units
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- Table: habits
-- Procedural memory — behavioral patterns agents develop over time
-- ============================================================
CREATE TABLE IF NOT EXISTS habits (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  trigger_condition TEXT NOT NULL,
  action TEXT NOT NULL,
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0.0
    CHECK (confidence >= 0.0 AND confidence <= 1.0),
  usage_count INTEGER NOT NULL DEFAULT 0
    CHECK (usage_count >= 0),
  formed_from_id TEXT NOT NULL DEFAULT '',
  formation_mode TEXT NOT NULL DEFAULT 'auto'
    CHECK (formation_mode IN ('auto', 'explicit')),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Primary lookup: habits for an agent
CREATE INDEX IF NOT EXISTS idx_habits_agent
  ON habits (agent_id)
  WHERE is_active = true;

-- GC: find inactive habits by company
CREATE INDEX IF NOT EXISTS idx_habits_company
  ON habits (company_id);

DROP TRIGGER IF EXISTS trg_habits_updated_at ON habits;
CREATE TRIGGER trg_habits_updated_at
  BEFORE UPDATE ON habits
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- Table: priming_state
-- Emotional/confidence state per agent — one row per agent
-- ============================================================
CREATE TABLE IF NOT EXISTS priming_state (
  agent_id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0.5
    CHECK (confidence >= 0.0 AND confidence <= 1.0),
  caution DOUBLE PRECISION NOT NULL DEFAULT 0.5
    CHECK (caution >= 0.0 AND caution <= 1.0),
  morale DOUBLE PRECISION NOT NULL DEFAULT 0.7
    CHECK (morale >= 0.0 AND morale <= 1.0),
  recent_events JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_priming_company
  ON priming_state (company_id);

DROP TRIGGER IF EXISTS trg_priming_state_updated_at ON priming_state;
CREATE TRIGGER trg_priming_state_updated_at
  BEFORE UPDATE ON priming_state
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMIT;
