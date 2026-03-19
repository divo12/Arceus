from __future__ import annotations

from arceus.core.hippocampus.hippocampus import Hippocampus
from arceus.core.hippocampus.types import MemoryType, MemoryUnit


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
            results.extend(await hippocampus.recall(query, self.startup_container(startup_id)))

        results.extend(
            await hippocampus.recall(query, self.employee_container(startup_id, employee_id))
        )

        if task_id:
            results.extend(
                await hippocampus.recall(query, self.task_container(startup_id, task_id))
            )

        return self._deduplicate_by_priority(results)

    def _deduplicate_by_priority(self, results: list[MemoryUnit]) -> list[MemoryUnit]:
        seen: dict[str, MemoryUnit] = {}
        priority = {
            MemoryType.STATIC: 3,
            MemoryType.DYNAMIC: 2,
            MemoryType.WORKING: 1,
        }

        for memory in results:
            key = memory.content[:120]
            existing = seen.get(key)
            if existing is None:
                seen[key] = memory
                continue
            if priority.get(memory.memory_type, 0) > priority.get(existing.memory_type, 0):
                seen[key] = memory

        return list(seen.values())
