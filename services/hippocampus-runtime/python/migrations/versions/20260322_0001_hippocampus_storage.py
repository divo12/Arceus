"""Add Hippocampus PostgreSQL storage schema.

Revision ID: 20260322_0001
Revises:
Create Date: 2026-03-22 12:00:00.000000
"""

from __future__ import annotations

from alembic import op

# revision identifiers, used by Alembic.
revision = "20260322_0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute('CREATE EXTENSION IF NOT EXISTS vector')
    op.execute('CREATE SCHEMA IF NOT EXISTS "hippocampus"')

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS "hippocampus".habits (
            id TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL,
            trigger_condition TEXT NOT NULL,
            action TEXT NOT NULL,
            confidence DOUBLE PRECISION NOT NULL,
            usage_count INTEGER NOT NULL,
            formed_from_id TEXT NOT NULL,
            formation_mode TEXT NOT NULL,
            is_active BOOLEAN NOT NULL,
            created_at TIMESTAMPTZ NOT NULL
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS "hippocampus".priming_state (
            agent_id TEXT PRIMARY KEY,
            payload JSONB NOT NULL
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS "hippocampus".patterns (
            id TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL,
            description TEXT NOT NULL,
            strategy TEXT NOT NULL,
            embedding JSONB,
            usage_count INTEGER NOT NULL,
            success_rate DOUBLE PRECISION NOT NULL,
            formed_from JSONB NOT NULL,
            cluster_id TEXT,
            status TEXT NOT NULL,
            domain TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS "hippocampus".memory_metadata (
            key TEXT PRIMARY KEY,
            value JSONB NOT NULL
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS "hippocampus".memory_units (
            id TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL,
            startup_id TEXT NOT NULL DEFAULT '',
            content TEXT NOT NULL,
            embedding vector(384),
            memory_type TEXT NOT NULL,
            confidence DOUBLE PRECISION NOT NULL,
            relevance_score DOUBLE PRECISION NOT NULL,
            container TEXT NOT NULL,
            visibility TEXT NOT NULL,
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            source_type TEXT NOT NULL DEFAULT '',
            source_id TEXT NOT NULL DEFAULT '',
            provenance TEXT NOT NULL DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL,
            expires_at TIMESTAMPTZ NULL,
            version INTEGER NOT NULL DEFAULT 1,
            previous_version_id TEXT NULL,
            promotion_status TEXT NULL,
            deleted_at TIMESTAMPTZ NULL,
            delete_reason TEXT NOT NULL DEFAULT ''
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_habits_agent_active
        ON "hippocampus".habits (agent_id, is_active, created_at)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_patterns_agent_created
        ON "hippocampus".patterns (agent_id, created_at)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_memory_units_agent_type
        ON "hippocampus".memory_units (agent_id, memory_type)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_memory_units_container
        ON "hippocampus".memory_units (container)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_memory_units_created_at
        ON "hippocampus".memory_units (created_at DESC)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_memory_units_expires_at
        ON "hippocampus".memory_units (agent_id, memory_type, expires_at)
        WHERE deleted_at IS NULL
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_memory_units_embedding_hnsw
        ON "hippocampus".memory_units
        USING hnsw (embedding vector_cosine_ops)
        """
    )


def downgrade() -> None:
    op.execute('DROP TABLE IF EXISTS "hippocampus".memory_units')
    op.execute('DROP TABLE IF EXISTS "hippocampus".memory_metadata')
    op.execute('DROP TABLE IF EXISTS "hippocampus".patterns')
    op.execute('DROP TABLE IF EXISTS "hippocampus".priming_state')
    op.execute('DROP TABLE IF EXISTS "hippocampus".habits')
    op.execute('DROP SCHEMA IF EXISTS "hippocampus"')
