from __future__ import annotations

from datetime import timedelta

import pytest

from arceus.core.hippocampus.types import MemoryType, MemoryUnit, Pattern
from arceus.core.hippocampus.utils.time import utc_now
from arceus.core.memory_projections import ArceusMemoryProjections
from arceus.core.memory_scope import ArceusMemoryScope
from tests.hippocampus.support.fakes.mock_embedding import MockEmbeddingEngine


@pytest.mark.asyncio
async def test_get_summary_includes_recent_promotions(hippocampus_factory) -> None:
    projections = ArceusMemoryProjections()
    scope = ArceusMemoryScope()
    hippocampus = await hippocampus_factory("emp-1")
    container = scope.employee_container("startup-1", "emp-1")
    embedding = MockEmbeddingEngine(dimensions=32)

    try:
        promotable = MemoryUnit(
            id="promotable",
            agent_id="emp-1",
            content="JWT expiry policy is a durable rule",
            embedding=await embedding.embed("JWT expiry policy is a durable rule"),
            memory_type=MemoryType.DYNAMIC,
            confidence=0.95,
            container=container,
            metadata={"usage_count": 12},
            created_at=utc_now() - timedelta(days=20),
            updated_at=utc_now() - timedelta(days=20),
        )
        await hippocampus._vector_store.upsert(promotable)

        await hippocampus.run_promotions()
        summary = await projections.get_summary(hippocampus, container=container)

        assert len(summary.recent_promotions) == 1
        assert "dynamic->static:" in summary.recent_promotions[0]
    finally:
        await hippocampus.close()


@pytest.mark.asyncio
async def test_get_summary_includes_top_patterns(hippocampus_factory) -> None:
    projections = ArceusMemoryProjections()
    scope = ArceusMemoryScope()
    hippocampus = await hippocampus_factory("emp-1")
    container = scope.employee_container("startup-1", "emp-1")
    embedding = MockEmbeddingEngine(dimensions=32)

    try:
        await hippocampus.remember(
            "Current auth rollout needs refresh-token metrics",
            container=container,
            memory_type=MemoryType.DYNAMIC,
        )
        assert hippocampus.pattern_learner is not None
        await hippocampus.pattern_learner._store.insert(
            Pattern(
                id="pattern-1",
                agent_id="emp-1",
                description="Clarify auth scope first",
                strategy="clarify requirements -> align security -> estimate",
                embedding=await embedding.embed("Clarify auth scope first"),
                usage_count=12,
                success_rate=0.91,
                formed_from=("traj-1",),
                domain="auth",
            )
        )

        summary = await projections.get_summary(hippocampus, container=container)

        assert summary.top_patterns[0]["description"] == "Clarify auth scope first"
        assert summary.top_patterns[0]["usage_count"] == 12
        assert summary.recent_learnings == ["Current auth rollout needs refresh-token metrics"]
    finally:
        await hippocampus.close()


@pytest.mark.asyncio
async def test_get_pattern_cards(hippocampus_factory) -> None:
    projections = ArceusMemoryProjections()
    hippocampus = await hippocampus_factory("emp-1")
    embedding = MockEmbeddingEngine(dimensions=32)

    try:
        assert hippocampus.pattern_learner is not None
        await hippocampus.pattern_learner._store.insert(
            Pattern(
                id="pattern-1",
                agent_id="emp-1",
                description="Clarify auth scope first",
                strategy="clarify requirements -> align security -> estimate",
                embedding=await embedding.embed("Clarify auth scope first"),
                usage_count=12,
                success_rate=0.9123,
                formed_from=("traj-1",),
                domain="auth",
            )
        )

        cards = await projections.get_pattern_cards(hippocampus, limit=10)

        assert cards == [
            {
                "id": "pattern-1",
                "description": "Clarify auth scope first",
                "strategy": "clarify requirements -> align security -> estimate",
                "domain": "auth",
                "success_rate": 0.912,
                "usage_count": 12,
                "status": "active",
            }
        ]
    finally:
        await hippocampus.close()


@pytest.mark.asyncio
async def test_get_summary_empty_when_no_engines(hippocampus_factory) -> None:
    projections = ArceusMemoryProjections()
    hippocampus = await hippocampus_factory("emp-1")

    try:
        hippocampus.pattern_learner = None
        hippocampus.promotion_engine = None

        summary = await projections.get_summary(hippocampus)
        cards = await projections.get_pattern_cards(hippocampus)

        assert summary.top_patterns == []
        assert summary.recent_promotions == []
        assert cards == []
    finally:
        await hippocampus.close()
