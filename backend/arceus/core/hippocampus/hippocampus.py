from __future__ import annotations

from dataclasses import dataclass

from arceus.core.hippocampus.backends.factory import (
    create_cache,
    create_embedding_engine,
    create_graph_store,
    create_llm_engine,
    create_relational,
    create_vector_store,
)
from arceus.core.hippocampus.backends.protocols import EmbeddingEngine, LLMEngine, VectorStore
from arceus.core.hippocampus.config import HippocampusConfig
from arceus.core.hippocampus.engines.extractor import MemoryExtractor
from arceus.core.hippocampus.engines.graph_store import GraphStore
from arceus.core.hippocampus.tiers.dynamic import DynamicMemory
from arceus.core.hippocampus.tiers.static import StaticMemory
from arceus.core.hippocampus.tiers.working import WorkingMemory
from arceus.core.hippocampus.types import (
    ExtractedFact,
    ExtractionMode,
    ExtractionResult,
    GraphEntity,
    MemoryType,
    MemoryUnit,
)
from arceus.core.hippocampus.utils.similarity import cosine_similarity


@dataclass(frozen=True)
class HippocampusBackends:
    """Groups low-level backend instances to keep the Hippocampus constructor lean."""

    embedding: EmbeddingEngine
    llm: LLMEngine
    llm_light: LLMEngine
    vector_store: VectorStore
    relational_store: object  # RelationalStore protocol


class Hippocampus:
    """Phase 2 Hippocampus container with extraction and graph wiring."""

    def __init__(
        self,
        agent_id: str,
        config: HippocampusConfig,
        working_memory: WorkingMemory,
        static_memory: StaticMemory,
        dynamic_memory: DynamicMemory,
        graph_store: GraphStore,
        memory_extractor: MemoryExtractor | None,
        backends: HippocampusBackends,
    ) -> None:
        self._agent_id = agent_id
        self._config = config
        self.working_memory = working_memory
        self.static_memory = static_memory
        self.dynamic_memory = dynamic_memory
        self.graph_store = graph_store
        self.memory_extractor = memory_extractor
        self._backends = backends
        # Convenience aliases used by recall/search/close
        self._embedding = backends.embedding
        self._vector_store = backends.vector_store
        self._relational_store = backends.relational_store

    @classmethod
    async def create(cls, agent_id: str, config: HippocampusConfig) -> Hippocampus:
        vector_store = create_vector_store(config.vector_store_backend, config)
        graph_backend = create_graph_store(config.graph_store_backend, config)
        cache_backend = create_cache(config.cache_backend, config)
        relational_store = create_relational(config.relational_backend, config)
        await relational_store.initialize()
        embedding_engine = create_embedding_engine(
            config.embedding_model,
            config.embedding_dimensions,
        )
        llm_engine = create_llm_engine(config.extraction_model, config)
        llm_light = create_llm_engine(config.lightweight_model, config)

        backends = HippocampusBackends(
            embedding=embedding_engine,
            llm=llm_engine,
            llm_light=llm_light,
            vector_store=vector_store,
            relational_store=relational_store,
        )

        working_memory = WorkingMemory(agent_id=agent_id, backend=cache_backend)
        graph_store = GraphStore(graph_backend, embedding_engine)
        static_memory = StaticMemory(
            agent_id=agent_id,
            vector_store=vector_store,
            embedding_engine=embedding_engine,
            graph_store=graph_store,
        )
        dynamic_memory = DynamicMemory(
            agent_id=agent_id,
            vector_store=vector_store,
            embedding_engine=embedding_engine,
            half_life_days=config.dynamic_memory_half_life_days,
            decay_threshold=config.decay_threshold,
        )

        instance = cls(
            agent_id=agent_id,
            config=config,
            working_memory=working_memory,
            static_memory=static_memory,
            dynamic_memory=dynamic_memory,
            graph_store=graph_store,
            memory_extractor=None,
            backends=backends,
        )
        instance.memory_extractor = MemoryExtractor(
            llm=llm_engine,
            llm_light=llm_light,
            embedding_engine=embedding_engine,
            hippocampus=instance,
        )
        return instance

    async def close(self) -> None:
        await self.graph_store.close()
        await self._relational_store.close()

    async def soft_delete(self, memory_id: str, reason: str = "") -> None:
        await self._vector_store.soft_delete(memory_id, reason=reason)

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
        raise ValueError(f"remember() does not support {memory_type.value}")

    async def recall(
        self,
        query: str,
        container: str,
        top_k: int = 10,
        include_graph: bool = True,
    ) -> list[MemoryUnit | GraphEntity]:
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
        graph_results: list[GraphEntity] = []
        if include_graph:
            graph_results = await self.graph_store.search(query, container, top_k=top_k)
        if not candidates and not graph_results:
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

        final_results: list[MemoryUnit | GraphEntity] = list(selected)
        seen_ids = {item.id for item in selected}
        for node in graph_results:
            if node.id in seen_ids:
                continue
            final_results.append(node)
            seen_ids.add(node.id)
            if len(final_results) >= top_k:
                break

        return final_results

    async def search(
        self,
        query: str,
        agent_id: str,
        container: str,
        top_k: int = 5,
    ) -> list[MemoryUnit]:
        del agent_id
        embedding = await self._embedding.embed(query)
        return await self._vector_store.search(
            embedding=embedding,
            container=container,
            top_k=top_k,
        )

    async def extract_from_conversation(
        self,
        messages: list[dict],
        container: str,
        mode: ExtractionMode = ExtractionMode.AGENT,
    ) -> ExtractionResult:
        if self.memory_extractor is None:
            return ExtractionResult()
        return await self.memory_extractor.extract(
            messages=messages,
            agent_id=self._agent_id,
            container=container,
            mode=mode,
        )

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
