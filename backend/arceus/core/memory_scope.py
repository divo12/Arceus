from __future__ import annotations

from arceus.core.hippocampus.hippocampus import Hippocampus
from arceus.core.hippocampus.types import MemoryType, MemoryUnit

_MEMORY_PRIORITY = {
    MemoryType.STATIC: 3,
    MemoryType.DYNAMIC: 2,
    MemoryType.WORKING: 1,
}


class ArceusMemoryScope:
    """Arceus adapter for canonical Hippocampus container naming and retrieval."""

    @staticmethod
    def startup_container(startup_id: str) -> str:
        return f"startup:{startup_id}"

    @staticmethod
    def employee_container(startup_id: str, employee_id: str) -> str:
        return f"startup:{startup_id}:emp:{employee_id}"

    @staticmethod
    def task_container(startup_id: str, task_id: str) -> str:
        return f"startup:{startup_id}:task:{task_id}"

    @staticmethod
    def sub_agent_container(startup_id: str, task_id: str, agent_id: str) -> str:
        return f"startup:{startup_id}:task:{task_id}:sub:{agent_id}"

    async def get_memories_for_agent(
        self,
        hippocampus: Hippocampus,
        query: str,
        startup_id: str,
        employee_id: str,
        task_id: str | None = None,
        include_shared: bool = True,
    ) -> list[MemoryUnit]:
        results: list[MemoryUnit] = []

        if include_shared:
            results.extend(
                await hippocampus.recall(
                    query, self.startup_container(startup_id), include_graph=False
                )
            )

        results.extend(
            await hippocampus.recall(
                query,
                self.employee_container(startup_id, employee_id),
                include_graph=False,
            )
        )

        if task_id:
            results.extend(
                await hippocampus.recall(
                    query,
                    self.task_container(startup_id, task_id),
                    include_graph=False,
                )
            )

        return self._deduplicate_by_priority(results)

    def _deduplicate_by_priority(self, results: list[MemoryUnit]) -> list[MemoryUnit]:
        seen: dict[str, MemoryUnit] = {}

        for memory in results:
            existing = seen.get(memory.content)
            if existing is None:
                seen[memory.content] = memory
                continue
            if _MEMORY_PRIORITY.get(memory.memory_type, 0) > _MEMORY_PRIORITY.get(
                existing.memory_type,
                0,
            ):
                seen[memory.content] = memory

        return list(seen.values())
