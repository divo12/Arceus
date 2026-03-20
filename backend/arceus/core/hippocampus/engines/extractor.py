from __future__ import annotations

import logging

from arceus.core.hippocampus.backends.protocols import EmbeddingEngine, LLMEngine
from arceus.core.hippocampus.prompts import (
    AGENT_EXTRACTION_PROMPT,
    MEETING_EXTRACTION_PROMPT,
    MEMORY_ACTION_DECISION_PROMPT,
    RELATIONSHIP_CLASSIFICATION_PROMPT,
    SUB_AGENT_EXTRACTION_PROMPT,
)
from arceus.core.hippocampus.types import (
    ExtractedFact,
    ExtractionMode,
    ExtractionResult,
    GraphEntity,
    Habit,
    HabitFormation,
    MemoryAction,
    MemoryType,
    RelationType,
)

logger = logging.getLogger(__name__)


class MemoryExtractor:
    """Doc-driven Phase 2 extraction pipeline."""

    def __init__(
        self,
        llm: LLMEngine,
        llm_light: LLMEngine,
        embedding_engine: EmbeddingEngine,
        hippocampus,
    ) -> None:
        self._llm = llm
        self._llm_light = llm_light
        self._embedding = embedding_engine
        self._hippocampus = hippocampus

    async def extract(
        self,
        messages: list[dict],
        agent_id: str,
        container: str,
        mode: ExtractionMode = ExtractionMode.AGENT,
    ) -> ExtractionResult:
        prompt = self._get_prompt(mode)
        facts = await self._llm.extract_structured(
            prompt=prompt,
            messages=messages,
            output_schema=list[ExtractedFact],
        )

        actions: list[tuple[MemoryAction, str, str]] = []
        for fact in facts:
            existing = await self._hippocampus.search(
                query=fact.text,
                agent_id=agent_id,
                container=container,
                top_k=5,
            )
            action = await self._decide_action(fact, existing)
            actions.append(action)

            match action[0]:
                case MemoryAction.ADD:
                    await self._add_to_tier(fact, agent_id, container)
                case MemoryAction.UPDATE:
                    await self._update_memory(action[1], fact, agent_id, container)
                case MemoryAction.DELETE:
                    await self._hippocampus.soft_delete(action[1], reason=action[2] or fact.text)
                case MemoryAction.NONE:
                    pass

            if fact.entities or fact.relationships:
                await self._update_graph(fact, container)

        return ExtractionResult(
            facts=tuple(facts),
            actions=tuple(actions),
        )

    async def _decide_action(
        self,
        fact: ExtractedFact,
        existing: list,
    ) -> tuple[MemoryAction, str, str]:
        if not existing:
            return (MemoryAction.ADD, "", "no existing match")

        decision = await self._llm.decide(
            prompt=MEMORY_ACTION_DECISION_PROMPT,
            fact=fact.text,
            existing_memories=[
                {"id": memory.id, "content": memory.content, "type": memory.memory_type.value}
                for memory in existing
            ],
        )
        action, target_id, reason = self._normalize_action(decision)
        valid_ids = {memory.id for memory in existing}
        if (
            action in {MemoryAction.UPDATE, MemoryAction.DELETE}
            and target_id not in valid_ids
        ):
            return (MemoryAction.NONE, "", "invalid_target_id")
        return (action, target_id, reason)

    async def _add_to_tier(
        self,
        fact: ExtractedFact,
        agent_id: str,
        container: str,
    ):
        if fact.is_permanent or fact.memory_type is MemoryType.STATIC:
            return await self._hippocampus.static_memory.add(fact, container)

        if fact.is_procedural or fact.memory_type is MemoryType.PROCEDURAL:
            procedural_memory = getattr(self._hippocampus, "procedural_memory", None)
            if procedural_memory is None or not hasattr(procedural_memory, "add_habit"):
                logger.warning(
                    "Procedural memory is unavailable; "
                    "storing procedural fact as dynamic memory instead"
                )
                return await self._hippocampus.dynamic_memory.add(fact, container)
            trigger, action = self._split_procedural_text(fact.text)
            habit = Habit(
                agent_id=agent_id,
                trigger_condition=trigger,
                action=action,
                confidence=fact.confidence,
                formation_mode=HabitFormation.EXPLICIT,
            )
            await procedural_memory.add_habit(habit)
            return habit

        return await self._hippocampus.dynamic_memory.add(fact, container)

    async def _update_memory(
        self,
        target_id: str,
        fact: ExtractedFact,
        agent_id: str,
        container: str,
    ):
        if fact.is_permanent or fact.memory_type is MemoryType.STATIC:
            return await self._hippocampus.static_memory.update(target_id, fact.text)

        await self._hippocampus.soft_delete(target_id, reason=f"updated: {fact.text}")
        return await self._add_to_tier(fact, agent_id=agent_id, container=container)

    async def _update_graph(self, fact: ExtractedFact, container: str) -> None:
        for entity_name in fact.entities:
            embedding = await self._embedding.embed(entity_name)
            entity = GraphEntity(
                name=entity_name,
                entity_type="auto",
                embedding=embedding,
                container=container,
            )
            existing = await self._hippocampus.graph_store.find_similar_node(
                embedding,
                threshold=0.7,
                container=container,
            )
            if existing is None:
                await self._hippocampus.graph_store.create_node(entity)
            else:
                await self._hippocampus.graph_store.merge_node(existing, entity)

        for source, relation, target in fact.relationships:
            relation_type = await self._classify_relation(source, target, relation)
            await self._hippocampus.graph_store.create_edge_by_name(
                source,
                target,
                relation_type,
                container=container,
            )

    async def _classify_relation(
        self,
        source: str,
        target: str,
        relation_text: str,
    ) -> RelationType:
        result = await self._llm_light.classify(
            prompt=RELATIONSHIP_CLASSIFICATION_PROMPT.format(
                source=source,
                target=target,
                relation_text=relation_text,
            ),
            options=[relation_type.value for relation_type in RelationType],
        )
        try:
            return RelationType(result.strip().lower())
        except ValueError:
            return RelationType.RELATED_TO

    def _get_prompt(self, mode: ExtractionMode) -> str:
        return {
            ExtractionMode.AGENT: AGENT_EXTRACTION_PROMPT,
            ExtractionMode.SUB_AGENT: SUB_AGENT_EXTRACTION_PROMPT,
            ExtractionMode.CONVERSATION: AGENT_EXTRACTION_PROMPT,
            ExtractionMode.MEETING: MEETING_EXTRACTION_PROMPT,
        }[mode]

    def _normalize_action(self, decision: dict) -> tuple[MemoryAction, str, str]:
        raw_action = str(decision.get("action", MemoryAction.NONE.value)).strip()
        try:
            action = MemoryAction[raw_action.upper()]
        except KeyError:
            try:
                action = MemoryAction(raw_action.lower())
            except ValueError:
                action = MemoryAction.NONE
        return (
            action,
            str(decision.get("target_id", "")),
            str(decision.get("reason", "")),
        )

    def _split_procedural_text(self, text: str) -> tuple[str, str]:
        if "->" in text:
            trigger, action = text.split("->", maxsplit=1)
            return trigger.strip(), action.strip()
        if "→" in text:
            trigger, action = text.split("→", maxsplit=1)
            return trigger.strip(), action.strip()
        return "", text.strip()
