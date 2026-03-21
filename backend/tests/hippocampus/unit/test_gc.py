from __future__ import annotations

from datetime import timedelta

import pytest

from arceus.core.hippocampus.backends.simple_embedding import MockEmbeddingEngine
from arceus.core.hippocampus.config import HippocampusConfig
from arceus.core.hippocampus.hippocampus import Hippocampus
from arceus.core.hippocampus.types import GCResult, MemoryType, MemoryUnit, Pattern
from arceus.core.hippocampus.utils.time import utc_now


async def _create_hippocampus(tmp_path, agent_id: str = "agent-1") -> Hippocampus:
    return await Hippocampus.create(
        agent_id=agent_id,
        config=HippocampusConfig(
            sqlite_path=str(tmp_path / f"{agent_id}.db"),
            embedding_model="simple",
            embedding_dimensions=32,
            graph_store_backend="in_memory",
            extraction_model="noop",
            lightweight_model="noop",
        ),
    )


@pytest.mark.asyncio
async def test_gc_runs_all_stages(tmp_path) -> None:
    hippocampus = await _create_hippocampus(tmp_path)

    try:
        result = await hippocampus.run_gc()

        assert isinstance(result, GCResult)
        assert result.expired_removed == 0
        assert result.decayed_removed == 0
        assert result.deduped == 0
        assert result.pruned == 0
        assert result.merged == 0
        assert result.patterns_merged == 0
        assert result.patterns_pruned == 0
        assert result.promotions_fired == 0
    finally:
        await hippocampus.close()


@pytest.mark.asyncio
async def test_gc_skips_promotion_candidates(tmp_path) -> None:
    hippocampus = await _create_hippocampus(tmp_path)

    try:
        qualifying_content = "Important long-term architectural rule"
        qualifying = MemoryUnit(
            id="qualifying",
            agent_id="agent-1",
            content=qualifying_content,
            embedding=await hippocampus._embedding.embed(qualifying_content),
            memory_type=MemoryType.DYNAMIC,
            confidence=0.95,
            container="startup:1:emp:agent-1",
            metadata={"usage_count": 12},
            created_at=utc_now() - timedelta(days=20),
            updated_at=utc_now() - timedelta(days=200),
        )
        decayed_content = "Temporary stale incident note"
        decayed = MemoryUnit(
            id="decayed",
            agent_id="agent-1",
            content=decayed_content,
            embedding=await hippocampus._embedding.embed(decayed_content),
            memory_type=MemoryType.DYNAMIC,
            confidence=0.2,
            container="startup:1:emp:agent-1",
            metadata={"usage_count": 1},
            created_at=utc_now() - timedelta(days=20),
            updated_at=utc_now() - timedelta(days=200),
        )
        await hippocampus._vector_store.upsert(qualifying)
        await hippocampus._vector_store.upsert(decayed)

        result = await hippocampus.run_gc()
        static_memories = await hippocampus._vector_store.list_by_type(
            agent_id="agent-1",
            memory_type=MemoryType.STATIC,
        )
        dynamic_memories = await hippocampus._vector_store.list_by_type(
            agent_id="agent-1",
            memory_type=MemoryType.DYNAMIC,
        )
        remaining_contents = {memory.content for memory in [*static_memories, *dynamic_memories]}

        assert qualifying_content in remaining_contents
        assert decayed_content not in remaining_contents
        assert result.promotions_fired >= 1
    finally:
        await hippocampus.close()


@pytest.mark.asyncio
async def test_gc_with_no_engines(tmp_path) -> None:
    hippocampus = await _create_hippocampus(tmp_path)

    try:
        hippocampus.reasoning_bank = None
        hippocampus.pattern_learner = None

        result = await hippocampus.run_gc()

        assert isinstance(result, GCResult)
        assert result.deduped == 0
        assert result.pruned == 0
        assert result.merged == 0
        assert result.patterns_merged == 0
        assert result.patterns_pruned == 0
    finally:
        await hippocampus.close()


@pytest.mark.asyncio
async def test_gc_integration_runs_decay_dedup_pattern_and_promotion_stages(tmp_path) -> None:
    hippocampus = await _create_hippocampus(tmp_path)
    embedding = MockEmbeddingEngine(dimensions=32)
    duplicate_embedding = [1.0] + [0.0] * 31

    try:
        expired = MemoryUnit(
            id="expired",
            agent_id="agent-1",
            content="Expired temporary note",
            embedding=await embedding.embed("Expired temporary note"),
            memory_type=MemoryType.DYNAMIC,
            confidence=0.6,
            container="startup:1:emp:agent-1",
            expires_at=utc_now() - timedelta(minutes=1),
        )
        decayed = MemoryUnit(
            id="decayed",
            agent_id="agent-1",
            content="Very old low-value context",
            embedding=await embedding.embed("Very old low-value context"),
            memory_type=MemoryType.DYNAMIC,
            confidence=0.2,
            container="startup:1:emp:agent-1",
            metadata={"usage_count": 1},
            created_at=utc_now() - timedelta(days=60),
            updated_at=utc_now() - timedelta(days=200),
        )
        left = MemoryUnit(
            id="dup-a",
            agent_id="agent-1",
            content="Duplicate auth memory A",
            embedding=duplicate_embedding,
            memory_type=MemoryType.DYNAMIC,
            confidence=0.9,
            container="startup:1:emp:agent-1",
        )
        right = MemoryUnit(
            id="dup-b",
            agent_id="agent-1",
            content="Duplicate auth memory B",
            embedding=duplicate_embedding,
            memory_type=MemoryType.DYNAMIC,
            confidence=0.7,
            container="startup:1:emp:agent-1",
        )
        promotable = MemoryUnit(
            id="promotable",
            agent_id="agent-1",
            content="Durable JWT policy",
            embedding=await embedding.embed("Durable JWT policy"),
            memory_type=MemoryType.DYNAMIC,
            confidence=0.95,
            container="startup:1:emp:agent-1",
            metadata={"usage_count": 12},
            created_at=utc_now() - timedelta(days=20),
            updated_at=utc_now() - timedelta(days=200),
        )
        await hippocampus._vector_store.upsert(expired)
        await hippocampus._vector_store.upsert(decayed)
        await hippocampus._vector_store.upsert(left)
        await hippocampus._vector_store.upsert(right)
        await hippocampus._vector_store.upsert(promotable)

        assert hippocampus.pattern_learner is not None
        await hippocampus.pattern_learner._store.insert(
            Pattern(
                id="pattern-a",
                agent_id="agent-1",
                description="auth pattern",
                strategy="inspect headers",
                embedding=await embedding.embed("auth pattern"),
                usage_count=10,
                success_rate=0.9,
                formed_from=("traj-1",),
                domain="auth",
            )
        )
        await hippocampus.pattern_learner._store.insert(
            Pattern(
                id="pattern-b",
                agent_id="agent-1",
                description="auth pattern",
                strategy="inspect cookies",
                embedding=await embedding.embed("auth pattern"),
                usage_count=12,
                success_rate=0.85,
                formed_from=("traj-2",),
                domain="auth",
            )
        )

        result = await hippocampus.run_gc()
        static_memories = await hippocampus._vector_store.list_by_type(
            agent_id="agent-1",
            memory_type=MemoryType.STATIC,
        )

        assert result.expired_removed >= 1
        assert result.decayed_removed >= 1
        assert result.deduped >= 1
        assert result.patterns_merged >= 1
        assert result.promotions_fired >= 1
        assert any(memory.content == "Durable JWT policy" for memory in static_memories)
    finally:
        await hippocampus.close()
