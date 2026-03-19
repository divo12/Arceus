from __future__ import annotations

from arceus.core.hippocampus.backends.factory import (
    create_cache,
    create_embedding_engine,
    create_relational,
    create_vector_store,
)
from arceus.core.hippocampus.config import HippocampusConfig
from arceus.core.hippocampus.tiers.dynamic import DynamicMemory
from arceus.core.hippocampus.tiers.static import StaticMemory
from arceus.core.hippocampus.tiers.working import WorkingMemory
from arceus.core.hippocampus.types import ExtractedFact, MemoryType, MemoryUnit
from arceus.core.hippocampus.utils.similarity import cosine_similarity


class Hippocampus:
    """Phase 0/1 Hippocampus container with exact-scope retrieval."""

    def __init__(
        self,
        agent_id: str,
        config: HippocampusConfig,
        working_memory: WorkingMemory,
        static_memory: StaticMemory,
        dynamic_memory: DynamicMemory,
        embedding_engine,
        vector_store,
        relational_store,
    ) -> None:
        self._agent_id = agent_id
        self._config = config
        self.working_memory = working_memory
        self.static_memory = static_memory
        self.dynamic_memory = dynamic_memory
        self._embedding = embedding_engine
        self._vector_store = vector_store
        self._relational_store = relational_store

    @classmethod
    async def create(cls, agent_id: str, config: HippocampusConfig) -> Hippocampus:
        vector_store = create_vector_store(config.vector_store_backend, config)
        cache_backend = create_cache(config.cache_backend, config)
        relational_store = create_relational(config.relational_backend, config)
        await relational_store.initialize()
        embedding_engine = create_embedding_engine(
            config.embedding_model,
            config.embedding_dimensions,
        )

        working_memory = WorkingMemory(agent_id=agent_id, backend=cache_backend)
        static_memory = StaticMemory(
            agent_id=agent_id,
            vector_store=vector_store,
            embedding_engine=embedding_engine,
        )
        dynamic_memory = DynamicMemory(
            agent_id=agent_id,
            vector_store=vector_store,
            embedding_engine=embedding_engine,
            half_life_days=config.dynamic_memory_half_life_days,
            decay_threshold=config.decay_threshold,
        )

        return cls(
            agent_id=agent_id,
            config=config,
            working_memory=working_memory,
            static_memory=static_memory,
            dynamic_memory=dynamic_memory,
            embedding_engine=embedding_engine,
            vector_store=vector_store,
            relational_store=relational_store,
        )

    async def close(self) -> None:
        await self._relational_store.close()

    async def remember(
        self,
        content: str,
        container: str,
        memory_type: MemoryType = MemoryType.DYNAMIC,
    ) -> MemoryUnit:
        if memory_type is MemoryType.STATIC:
            fact = ExtractedFact(
                text=content,
                memory_type=MemoryType.STATIC,
                confidence=1.0,
                is_permanent=True,
            )
            return await self.static_memory.add(fact, container)
        if memory_type is MemoryType.DYNAMIC:
            fact = ExtractedFact(
                text=content,
                memory_type=MemoryType.DYNAMIC,
                confidence=1.0,
            )
            return await self.dynamic_memory.add(fact, container)
        raise ValueError(f"Phase 0/1 remember() does not support {memory_type.value}")

    async def recall(
        self,
        query: str,
        container: str,
        top_k: int = 10,
        include_graph: bool = True,
    ) -> list[MemoryUnit]:
        del include_graph  # Graph-backed retrieval begins in Phase 2.

        query_embedding = await self._embedding.embed(query)
        static_results = await self.static_memory.search(
            query,
            container,
            top_k=max(top_k * 3, top_k),
        )
        dynamic_results = await self.dynamic_memory.search(
            query,
            container,
            top_k=max(top_k * 3, top_k),
        )

        candidates = static_results + dynamic_results
        if not candidates:
            return []

        selected: list[MemoryUnit] = []
        remaining = candidates[:]
        scope_boost = self._scope_boost(container)

        while remaining and len(selected) < top_k:
            best_index = 0
            best_score = float("-inf")

            for index, candidate in enumerate(remaining):
                relevance = cosine_similarity(query_embedding, candidate.embedding or [])
                tier_boost = self._tier_boost(candidate.memory_type)
                base_score = relevance * tier_boost * scope_boost * candidate.relevance_score
                if not selected:
                    score = base_score
                else:
                    redundancy = max(
                        cosine_similarity(candidate.embedding or [], chosen.embedding or [])
                        for chosen in selected
                    )
                    score = (
                        self._config.mmr_lambda * base_score
                        - (1 - self._config.mmr_lambda) * redundancy
                    )

                if score > best_score:
                    best_score = score
                    best_index = index

            selected.append(remaining.pop(best_index))

        return selected

    def _tier_boost(self, memory_type: MemoryType) -> float:
        if memory_type is MemoryType.STATIC:
            return self._config.static_boost
        if memory_type is MemoryType.DYNAMIC:
            return self._config.dynamic_boost
        if memory_type is MemoryType.PROCEDURAL:
            return self._config.procedural_boost
        return 1.0

    def _scope_boost(self, container: str) -> float:
        return self._config.task_scope_boost if ":task:" in container else 1.0
