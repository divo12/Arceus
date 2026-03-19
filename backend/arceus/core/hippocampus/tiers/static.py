from __future__ import annotations

from arceus.core.hippocampus.backends.protocols import EmbeddingEngine, VectorStore
from arceus.core.hippocampus.types import ExtractedFact, MemoryType, MemoryUnit
from arceus.core.hippocampus.utils.time import utc_now


class StaticMemory:
    """Tier 2 permanent memory."""

    def __init__(
        self,
        agent_id: str,
        vector_store: VectorStore,
        embedding_engine: EmbeddingEngine,
    ) -> None:
        self._agent_id = agent_id
        self._vector_store = vector_store
        self._embedding = embedding_engine

    async def add(self, fact: ExtractedFact, container: str) -> MemoryUnit:
        embedding = await self._embedding.embed(fact.text)
        unit = MemoryUnit(
            agent_id=self._agent_id,
            content=fact.text,
            embedding=embedding,
            memory_type=MemoryType.STATIC,
            confidence=fact.confidence,
            relevance_score=1.0,
            container=container,
            source_type="remember",
            updated_at=utc_now(),
        )
        await self._vector_store.upsert(unit)
        return unit

    async def search(self, query: str, container: str, top_k: int = 10) -> list[MemoryUnit]:
        query_embedding = await self._embedding.embed(query)
        return await self._vector_store.search(
            embedding=query_embedding,
            container=container,
            memory_types=[MemoryType.STATIC],
            top_k=top_k,
        )

    async def get_all(self, container: str) -> list[MemoryUnit]:
        return await self._vector_store.list_by_type(
            agent_id=self._agent_id,
            container=container,
            memory_type=MemoryType.STATIC,
        )
