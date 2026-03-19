"""
DelegationMemoryManager — Arceus adapter for Employee delegation memory flow.

Spec reference: hippocampus_design_v6.md section 8.3 / Flow B
Key principle: memories are COPIED, never referenced.
"""
from __future__ import annotations

from arceus.core.hippocampus.hippocampus import Hippocampus
from arceus.core.hippocampus.types import MemoryType, MemoryUnit
from arceus.core.memory_scope import ArceusMemoryScope


class DelegationMemoryManager:
    """
    Handles memory context injection during Employee-to-Employee delegation.
    Knows about delegation authority and org hierarchy (Arceus-domain logic).
    """

    def __init__(self, scope: ArceusMemoryScope | None = None) -> None:
        self._scope = scope or ArceusMemoryScope()

    async def prepare_delegation_context(
        self,
        from_hippocampus: Hippocampus,
        to_hippocampus: Hippocampus,
        from_agent_id: str,
        to_agent_id: str,
        startup_id: str,
        task_id: str,
        task_description: str,
        top_k: int = 10,
    ) -> list[MemoryUnit]:
        """
        Query delegator's hippocampus for task-relevant memories,
        COPY them into the delegatee's task-scoped container.
        Returns the list of copied memories.
        """
        from_container = self._scope.employee_container(startup_id, from_agent_id)
        task_container = self._scope.task_container(startup_id, task_id)

        relevant = await from_hippocampus.recall(
            query=task_description,
            container=from_container,
            top_k=top_k,
        )

        copied: list[MemoryUnit] = []
        for mem in relevant:
            if not isinstance(mem, MemoryUnit):
                continue
            copy = MemoryUnit(
                agent_id=to_agent_id,
                startup_id=startup_id,
                content=mem.content,
                embedding=mem.embedding,
                memory_type=MemoryType.DYNAMIC,
                confidence=mem.confidence,
                container=task_container,
                visibility=mem.visibility,
                source_type="delegation",
                source_id=from_agent_id,
                provenance=f"Delegated from {from_agent_id}",
                metadata={"delegated_from": from_agent_id},
            )
            await to_hippocampus._vector_store.upsert(copy)
            copied.append(copy)

        return copied

    async def internalize_delegation_result(
        self,
        delegator_hippocampus: Hippocampus,
        delegator_agent_id: str,
        startup_id: str,
        learnings: list[str],
        quality: float,
    ) -> None:
        """
        After delegation completes, internalize verified learnings
        into the delegator's personal memory.
        Quality >= 0.6 = dynamic, >= 0.9 = static.
        """
        if quality < 0.6:
            return

        container = self._scope.employee_container(startup_id, delegator_agent_id)
        for learning in learnings:
            memory_type = MemoryType.STATIC if quality >= 0.9 else MemoryType.DYNAMIC
            await delegator_hippocampus.remember(
                content=learning,
                container=container,
                memory_type=memory_type,
            )
