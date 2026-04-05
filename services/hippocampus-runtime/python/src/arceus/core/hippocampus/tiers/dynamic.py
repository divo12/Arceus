from __future__ import annotations

from datetime import timedelta
from typing import TYPE_CHECKING

from arceus.core.hippocampus.backends.protocols import EmbeddingEngine, VectorStore
from arceus.core.hippocampus.types import ExtractedFact, MemoryType, MemoryUnit, extract_company_id
from arceus.core.hippocampus.utils.time import utc_now


class DynamicMemory:
    """Tier 3 time-decaying contextual memory."""

    def __init__(
        self,
        agent_id: str,
        vector_store: VectorStore,
        embedding_engine: EmbeddingEngine,
        half_life_days: float = 30.0,
        decay_threshold: float = 0.1,
    ) -> None:
        if half_life_days <= 0:
            raise ValueError("half_life_days must be greater than 0")
        self._agent_id = agent_id
        self._vector_store = vector_store
        self._embedding = embedding_engine
        self._half_life_days = half_life_days
        self._decay_threshold = decay_threshold

    async def add(self, fact: ExtractedFact, container: str) -> MemoryUnit:
        embedding = await self._embedding.embed(fact.text)
        unit = MemoryUnit(
            agent_id=self._agent_id,
            company_id=extract_company_id(container),
            content=fact.text,
            embedding=embedding,
            memory_type=MemoryType.DYNAMIC,
            confidence=fact.confidence,
            relevance_score=1.0,
            container=container,
            source_type=fact.source_type,
            expires_at=fact.expires_at,
            updated_at=utc_now(),
        )
        await self._vector_store.upsert(unit)
        return unit

    async def search(self, query: str, container: str, top_k: int = 10) -> list[MemoryUnit]:
        query_embedding = await self._embedding.embed(query)
        candidates = await self._vector_store.search(
            embedding=query_embedding,
            container=container,
            agent_id=self._agent_id,
            memory_types=[MemoryType.DYNAMIC],
            top_k=top_k * 3,
        )
        scored: list[tuple[float, MemoryUnit]] = []
        for memory in candidates:
            score = memory.relevance_score * self._decay_factor(memory)
            if score >= self._decay_threshold:
                scored.append((score, memory))
        scored.sort(key=lambda item: item[0], reverse=True)
        return [memory for _, memory in scored[:top_k]]

    async def find_expired(self) -> list[MemoryUnit]:
        return await self._vector_store.find_expired(
            agent_id=self._agent_id,
            memory_type=MemoryType.DYNAMIC,
            before=utc_now(),
        )

    async def find_decayed(self) -> list[MemoryUnit]:
        memories = await self._vector_store.list_by_type(
            agent_id=self._agent_id,
            memory_type=MemoryType.DYNAMIC,
        )
        decayed: list[tuple[float, MemoryUnit]] = []
        for memory in memories:
            score = memory.relevance_score * self._decay_factor(memory)
            if score < self._decay_threshold:
                decayed.append((score, memory))
        decayed.sort(key=lambda item: item[0])
        return [memory for _, memory in decayed]

    async def get_recent(self, container: str, days: int = 7) -> list[MemoryUnit]:
        cutoff = utc_now() - timedelta(days=days)
        return await self._vector_store.list_by_type(
            agent_id=self._agent_id,
            container=container,
            memory_type=MemoryType.DYNAMIC,
            created_after=cutoff,
        )

    def _decay_factor(self, memory: MemoryUnit) -> float:
        age_days = (utc_now() - memory.updated_at).total_seconds() / 86400
        return 0.5 ** (age_days / self._half_life_days)
