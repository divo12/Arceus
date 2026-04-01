"""Copy Hippocampus schema data into the main public memory tables.

Revision ID: 20260401_0002
Revises: 20260322_0001
Create Date: 2026-04-01 12:00:00.000000
"""

from __future__ import annotations

from alembic import op

# revision identifiers, used by Alembic.
revision = "20260401_0002"
down_revision = "20260322_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.schemata WHERE schema_name = 'hippocampus'
          ) THEN
            INSERT INTO public.memory_priming_state (agent_id, company_id, payload, updated_at)
            SELECT
              ps.agent_id::uuid,
              a.company_id,
              ps.payload,
              NOW()
            FROM hippocampus.priming_state ps
            JOIN public.agents a ON a.id::text = ps.agent_id
            ON CONFLICT (agent_id) DO UPDATE
            SET payload = EXCLUDED.payload,
                company_id = EXCLUDED.company_id,
                updated_at = EXCLUDED.updated_at;

            INSERT INTO public.memory_habits (
              id,
              company_id,
              agent_id,
              trigger_condition,
              action,
              confidence,
              usage_count,
              source_pattern_id,
              is_active,
              created_at,
              updated_at
            )
            SELECT
              h.id::uuid,
              a.company_id,
              h.agent_id::uuid,
              h.trigger_condition,
              h.action,
              h.confidence,
              h.usage_count,
              NULLIF(h.formed_from_id, '')::uuid,
              h.is_active,
              h.created_at,
              NOW()
            FROM hippocampus.habits h
            JOIN public.agents a ON a.id::text = h.agent_id
            ON CONFLICT (id) DO UPDATE
            SET trigger_condition = EXCLUDED.trigger_condition,
                action = EXCLUDED.action,
                confidence = EXCLUDED.confidence,
                usage_count = EXCLUDED.usage_count,
                source_pattern_id = EXCLUDED.source_pattern_id,
                is_active = EXCLUDED.is_active,
                updated_at = EXCLUDED.updated_at;

            INSERT INTO public.memory_patterns (
              id,
              company_id,
              agent_id,
              description,
              strategy,
              embedding,
              usage_count,
              success_rate,
              status,
              domain,
              created_at,
              updated_at
            )
            SELECT
              p.id::uuid,
              a.company_id,
              p.agent_id::uuid,
              p.description,
              p.strategy,
              CASE WHEN p.embedding IS NULL THEN NULL ELSE (p.embedding::text)::vector END,
              p.usage_count,
              p.success_rate,
              CASE
                WHEN p.status IN ('merged', 'pruned', 'archived') THEN 'deprecated'
                WHEN p.status = 'failed' THEN 'failed'
                ELSE 'active'
              END,
              NULLIF(p.domain, ''),
              p.created_at,
              p.updated_at
            FROM hippocampus.patterns p
            JOIN public.agents a ON a.id::text = p.agent_id
            ON CONFLICT (id) DO UPDATE
            SET description = EXCLUDED.description,
                strategy = EXCLUDED.strategy,
                embedding = EXCLUDED.embedding,
                usage_count = EXCLUDED.usage_count,
                success_rate = EXCLUDED.success_rate,
                status = EXCLUDED.status,
                domain = EXCLUDED.domain,
                updated_at = EXCLUDED.updated_at;

            INSERT INTO public.memory_units (
              id,
              company_id,
              agent_id,
              content,
              embedding,
              memory_type,
              confidence,
              relevance_score,
              container,
              visibility,
              metadata,
              source_type,
              source_id,
              provenance,
              version,
              previous_version_id,
              promotion_status,
              expires_at,
              deleted_at,
              delete_reason,
              created_at,
              updated_at
            )
            SELECT
              mu.id::uuid,
              a.company_id,
              mu.agent_id::uuid,
              mu.content,
              mu.embedding,
              CASE
                WHEN mu.memory_type IN ('static', 'dynamic', 'working') THEN mu.memory_type
                ELSE 'dynamic'
              END,
              mu.confidence,
              mu.relevance_score,
              mu.container,
              CASE
                WHEN mu.visibility = 'shared' THEN 'startup_shared'
                WHEN mu.visibility = 'board' THEN 'board_visible'
                ELSE COALESCE(NULLIF(mu.visibility, ''), 'private')
              END,
              COALESCE(mu.metadata, '{}'::jsonb),
              NULLIF(mu.source_type, ''),
              NULLIF(mu.source_id, ''),
              NULLIF(mu.provenance, ''),
              COALESCE(mu.version, 1),
              NULLIF(mu.previous_version_id, '')::uuid,
              COALESCE(mu.promotion_status, 'pending'),
              mu.expires_at,
              mu.deleted_at,
              NULLIF(mu.delete_reason, ''),
              mu.created_at,
              mu.updated_at
            FROM hippocampus.memory_units mu
            JOIN public.agents a ON a.id::text = mu.agent_id
            ON CONFLICT (id) DO UPDATE
            SET content = EXCLUDED.content,
                embedding = EXCLUDED.embedding,
                memory_type = EXCLUDED.memory_type,
                confidence = EXCLUDED.confidence,
                relevance_score = EXCLUDED.relevance_score,
                container = EXCLUDED.container,
                visibility = EXCLUDED.visibility,
                metadata = EXCLUDED.metadata,
                source_type = EXCLUDED.source_type,
                source_id = EXCLUDED.source_id,
                provenance = EXCLUDED.provenance,
                version = EXCLUDED.version,
                previous_version_id = EXCLUDED.previous_version_id,
                promotion_status = EXCLUDED.promotion_status,
                expires_at = EXCLUDED.expires_at,
                deleted_at = EXCLUDED.deleted_at,
                delete_reason = EXCLUDED.delete_reason,
                updated_at = EXCLUDED.updated_at;
          END IF;
        END $$;
        """
    )


def downgrade() -> None:
    # Data was copied forward into the main public tables.
    # We intentionally do not delete or reconstruct legacy hippocampus schema data here.
    pass
