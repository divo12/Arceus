from __future__ import annotations

from typing import TYPE_CHECKING

from arceus.core.hippocampus.backends.protocols import EmbeddingEngine, VectorStore
from arceus.core.hippocampus.types import ExtractedFact, MemoryType, MemoryUnit, RelationType
from arceus.core.hippocampus.utils.time import utc_now

if TYPE_CHECKING:
    from arceus.core.hippocampus.engines.graph_store import GraphStore


class StaticMemory:
    """Tier 2 permanent memory."""

    def __init__(
        self,
        agent_id: str,
        vector_store: VectorStore,
        embedding_engine: EmbeddingEngine,
        graph_store: GraphStore | None = None,
    ) -> None:
        self._agent_id = agent_id
        self._vector_store = vector_store
        self._embedding = embedding_engine
        self._graph_store = graph_store

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

    async def update(self, memory_id: str, new_content: str) -> MemoryUnit:
        existing = await self._vector_store.get(memory_id)
        if existing is None:
            raise ValueError(f"Static memory {memory_id} does not exist")

        new_embedding = await self._embedding.embed(new_content)
        updated = MemoryUnit(
            agent_id=existing.agent_id,
            startup_id=existing.startup_id,
            content=new_content,
            embedding=new_embedding,
            memory_type=MemoryType.STATIC,
            confidence=existing.confidence,
            relevance_score=1.0,
            container=existing.container,
            visibility=existing.visibility,
            metadata=dict(existing.metadata),
            source_type=existing.source_type,
            source_id=existing.source_id,
            provenance=existing.provenance,
            updated_at=utc_now(),
            expires_at=existing.expires_at,
            version=existing.version + 1,
            previous_version_id=existing.id,
            promotion_status=existing.promotion_status,
        )
        await self._vector_store.upsert(updated)
        if self._graph_store is not None:
            await self._graph_store.create_edge(updated.id, existing.id, RelationType.UPDATES)
        return updated

    async def get_all(self, container: str) -> list[MemoryUnit]:
        return await self._vector_store.list_by_type(
            agent_id=self._agent_id,
            container=container,
            memory_type=MemoryType.STATIC,
        )
