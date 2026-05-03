-- ─────────────────────────────────────────────────────────────────
-- Arceus Postgres bootstrap (runs ONCE on first container start).
-- Mounted at /docker-entrypoint-initdb.d/00-arceus-init.sql by docker-compose.yml.
-- ─────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS vector;     -- hippocampus.memory_embeddings
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- trigram indexes on memory content
