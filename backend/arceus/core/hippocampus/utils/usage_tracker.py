from __future__ import annotations

from dataclasses import replace

from arceus.core.hippocampus.backends.protocols import VectorStore
from arceus.core.hippocampus.types import MemoryUnit
from arceus.core.hippocampus.utils.time import utc_now


class UsageTracker:
    """Tracks genuine agent usage of memories, separate from retrieval.

    Only called from Hippocampus.recall() — the one place where
    a search represents real agent usage of a memory.
    """

    def __init__(self, vector_store: VectorStore) -> None:
        self._vector_store = vector_store

    async def record_access(self, memories: list[MemoryUnit]) -> list[MemoryUnit]:
        updated: list[MemoryUnit] = []
        for mem in memories:
            usage_count = int(mem.metadata.get("usage_count", 0)) + 1
            new_metadata = {
                **mem.metadata,
                "usage_count": usage_count,
                "last_accessed": utc_now().isoformat(),
            }
            if "probation_until" in mem.metadata:
                probation_count = int(mem.metadata.get("probation_usage_count", 0)) + 1
                new_metadata["probation_usage_count"] = probation_count
            touched = replace(mem, metadata=new_metadata)
            await self._vector_store.upsert(touched)
            updated.append(touched)
        return updated
