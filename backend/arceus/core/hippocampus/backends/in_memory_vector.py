from __future__ import annotations

from datetime import datetime

from arceus.core.hippocampus.types import MemoryType, MemoryUnit, MemoryVisibility
from arceus.core.hippocampus.utils.similarity import cosine_similarity


def _is_accessible(memory: MemoryUnit, agent_id: str) -> bool:
    if not agent_id:
        return True
    if memory.agent_id == agent_id:
        return True
    if memory.visibility is not MemoryVisibility.PRIVATE:
        return True
    return False


class InMemoryVectorStore:
    """Simple in-process vector store for MVP Phase 0/1 work."""

    def __init__(self) -> None:
        self._items: dict[str, MemoryUnit] = {}
        self._deleted: dict[str, str] = {}

    async def upsert(self, unit: MemoryUnit) -> None:
        self._items[unit.id] = unit
        self._deleted.pop(unit.id, None)

    async def get(self, memory_id: str) -> MemoryUnit | None:
        if memory_id in self._deleted:
            return None
        return self._items.get(memory_id)

    async def search(
        self,
        embedding: list[float],
        container: str,
        *,
        agent_id: str = "",
        memory_types: list[MemoryType] | None = None,
        top_k: int = 10,
    ) -> list[MemoryUnit]:
        results: list[tuple[float, MemoryUnit]] = []
        for memory in self._items.values():
            if memory.id in self._deleted:
                continue
            if memory.container != container:
                continue
            if not _is_accessible(memory, agent_id):
                continue
            if memory_types and memory.memory_type not in memory_types:
                continue
            score = cosine_similarity(embedding, memory.embedding or [])
            results.append((score, memory))

        results.sort(key=lambda item: (item[0], item[1].updated_at), reverse=True)
        return [memory for _, memory in results[:top_k]]

    async def list_by_type(
        self,
        agent_id: str,
        memory_type: MemoryType | None = None,
        memory_types: list[MemoryType] | None = None,
        container: str | None = None,
        created_after: datetime | None = None,
    ) -> list[MemoryUnit]:
        selected: list[MemoryUnit] = []
        allowed_types = memory_types or ([memory_type] if memory_type else None)

        for memory in self._items.values():
            if memory.id in self._deleted:
                continue
            if memory.agent_id != agent_id:
                continue
            if allowed_types and memory.memory_type not in allowed_types:
                continue
            if container is not None and memory.container != container:
                continue
            if created_after is not None and memory.created_at < created_after:
                continue
            selected.append(memory)

        selected.sort(key=lambda memory: memory.updated_at, reverse=True)
        return selected

    async def soft_delete(self, memory_id: str, reason: str = "") -> None:
        if memory_id in self._items:
            self._deleted[memory_id] = reason

    async def find_expired(
        self,
        agent_id: str,
        memory_type: MemoryType,
        before: datetime,
    ) -> list[MemoryUnit]:
        results: list[MemoryUnit] = []
        for memory in self._items.values():
            if memory.id in self._deleted:
                continue
            if memory.agent_id != agent_id or memory.memory_type is not memory_type:
                continue
            if memory.expires_at and memory.expires_at <= before:
                results.append(memory)
        results.sort(key=lambda memory: memory.expires_at or before)
        return results
