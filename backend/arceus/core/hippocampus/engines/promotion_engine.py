"""
PromotionEngine — fully automatic memory promotion.

v6: LLM contradiction check (gpt-4o-mini) before promotion.
LLM-generated human-readable promotion reasons for dashboard.
"""
from __future__ import annotations

from datetime import timedelta

from arceus.core.hippocampus.backends.protocols import (
    EmbeddingEngine,
    LLMEngine,
    VectorStore,
)
from arceus.core.hippocampus.engines.graph_store import GraphStore
from arceus.core.hippocampus.prompts import (
    CONTRADICTION_CHECK_PROMPT,
    PROMOTION_REASON_PROMPT,
)
from arceus.core.hippocampus.types import (
    GraphRelationship,
    MemoryPromotionEvent,
    MemoryType,
    MemoryUnit,
    RelationType,
)
from arceus.core.hippocampus.utils.similarity import cosine_similarity
from arceus.core.hippocampus.utils.time import parse_utc_iso, utc_now


class PromotionEngine:
    MAX_PROMOTIONS_PER_CYCLE = 5
    PROBATION_DAYS = 7
    STATIC_ACCESS_THRESHOLD = 10
    STATIC_CONFIDENCE_THRESHOLD = 0.8
    STATIC_AGE_DAYS_THRESHOLD = 14
    UNUSED_STATIC_DEMOTION_DAYS = 60

    def __init__(
        self,
        agent_id: str,
        vector_store: VectorStore,
        graph_store: GraphStore,
        embedding_engine: EmbeddingEngine,
        llm_light: LLMEngine,
    ) -> None:
        self._agent_id = agent_id
        self._vector_store = vector_store
        self._graph_store = graph_store
        self._embedding = embedding_engine
        self._llm = llm_light

    async def run_promotions(self) -> list[MemoryPromotionEvent]:
        dynamic_memories = await self._vector_store.list_by_type(
            agent_id=self._agent_id,
            memory_type=MemoryType.DYNAMIC,
        )
        events: list[MemoryPromotionEvent] = []
        for mem in dynamic_memories:
            if len(events) >= self.MAX_PROMOTIONS_PER_CYCLE:
                break
            if self._qualifies_for_static(mem):
                has_contradiction = await self._check_contradiction(mem)
                if has_contradiction:
                    continue
                event = await self._promote_to_static(mem)
                if event:
                    events.append(event)
        return events

    def _qualifies_for_static(self, mem: MemoryUnit) -> bool:
        uses = mem.metadata.get("usage_count", 0)
        age_days = self._age_days(mem)
        return (
            uses >= self.STATIC_ACCESS_THRESHOLD
            and mem.confidence >= self.STATIC_CONFIDENCE_THRESHOLD
            and age_days >= self.STATIC_AGE_DAYS_THRESHOLD
            and mem.promotion_status is None
        )

    async def _check_contradiction(self, mem: MemoryUnit) -> bool:
        """Two-step: cosine pre-filter >0.80, then LLM verify."""
        static_memories = await self._vector_store.list_by_type(
            agent_id=self._agent_id,
            memory_type=MemoryType.STATIC,
        )
        for static_mem in static_memories:
            if mem.embedding and static_mem.embedding:
                sim = cosine_similarity(mem.embedding, static_mem.embedding)
                if sim > 0.80:
                    verdict = await self._llm.classify(
                        prompt=CONTRADICTION_CHECK_PROMPT.format(
                            memory_a=mem.content,
                            memory_b=static_mem.content,
                        ),
                        options=["CONTRADICTION", "NO_CONTRADICTION"],
                    )
                    if verdict.strip() == "CONTRADICTION":
                        return True
        return False

    async def _promote_to_static(
        self,
        mem: MemoryUnit,
    ) -> MemoryPromotionEvent | None:
        reason = await self._generate_promotion_reason(mem)
        probation_until = (utc_now() + timedelta(days=self.PROBATION_DAYS)).isoformat()

        promoted = MemoryUnit(
            agent_id=mem.agent_id,
            startup_id=mem.startup_id,
            content=mem.content,
            embedding=mem.embedding,
            memory_type=MemoryType.STATIC,
            confidence=mem.confidence,
            relevance_score=1.0,
            container=mem.container,
            visibility=mem.visibility,
            metadata={
                **mem.metadata,
                "promoted_from": mem.id,
                "probation_until": probation_until,
            },
            source_type=mem.source_type,
            source_id=mem.source_id,
            provenance=f"Auto-promoted from dynamic memory {mem.id}",
            promotion_status="promoted",
        )
        await self._vector_store.upsert(promoted)
        await self._vector_store.soft_delete(mem.id, reason="promoted_to_static")

        edge = GraphRelationship(
            source_id=promoted.id,
            target_id=mem.id,
            relation_type=RelationType.PROMOTED_FROM,
        )
        await self._graph_store.add_relationship(edge)

        return MemoryPromotionEvent(
            agent_id=self._agent_id,
            memory_id=promoted.id,
            from_type="dynamic",
            to_type="static",
            reason=reason,
            status="promoted",
        )

    async def _generate_promotion_reason(self, mem: MemoryUnit) -> str:
        return await self._llm.generate(
            prompt=PROMOTION_REASON_PROMPT.format(
                content=mem.content,
                access_count=mem.metadata.get("usage_count", 0),
                confidence=f"{mem.confidence:.2f}",
                age_days=f"{self._age_days(mem):.0f}",
                source_type=mem.source_type or "extraction",
            ),
        )

    async def demote(self, memory_id: str, reason: str) -> MemoryUnit | None:
        mem = await self._vector_store.get(memory_id)
        if not mem or mem.memory_type != MemoryType.STATIC:
            return None
        demoted = MemoryUnit(
            agent_id=mem.agent_id,
            startup_id=mem.startup_id,
            content=mem.content,
            embedding=mem.embedding,
            memory_type=MemoryType.DYNAMIC,
            confidence=mem.confidence * 0.8,
            relevance_score=0.5,
            container=mem.container,
            visibility=mem.visibility,
            metadata={**mem.metadata, "demoted_from": mem.id, "demotion_reason": reason},
            source_type=mem.source_type,
            source_id=mem.source_id,
            provenance=f"Demoted from static: {reason}",
        )
        await self._vector_store.upsert(demoted)
        await self._vector_store.soft_delete(mem.id, reason=f"demoted: {reason}")
        return demoted

    async def check_probation_demotions(self) -> list[MemoryUnit]:
        static_memories = await self._vector_store.list_by_type(
            agent_id=self._agent_id,
            memory_type=MemoryType.STATIC,
        )
        demoted: list[MemoryUnit] = []
        now = utc_now()
        for mem in static_memories:
            probation_until = mem.metadata.get("probation_until")
            if not probation_until:
                continue
            probation_end = parse_utc_iso(probation_until)
            if now < probation_end:
                uses_since = mem.metadata.get("usage_count", 0)
                if uses_since == 0:
                    result = await self.demote(mem.id, "unused_during_probation")
                    if result:
                        demoted.append(result)
        return demoted

    async def check_unused_static_demotions(self) -> list[MemoryUnit]:
        static_memories = await self._vector_store.list_by_type(
            agent_id=self._agent_id,
            memory_type=MemoryType.STATIC,
        )
        demoted: list[MemoryUnit] = []
        now = utc_now()
        for mem in static_memories:
            last_accessed = mem.metadata.get("last_accessed")
            if last_accessed:
                days_since = (now - parse_utc_iso(last_accessed)).total_seconds() / 86400
                if days_since >= self.UNUSED_STATIC_DEMOTION_DAYS:
                    result = await self.demote(mem.id, "unused_static_60d")
                    if result:
                        demoted.append(result)
        return demoted

    def _age_days(self, mem: MemoryUnit) -> float:
        return (utc_now() - mem.created_at).total_seconds() / 86400
