from __future__ import annotations

from arceus.core.hippocampus.backends.protocols import RelationalStore
from arceus.core.hippocampus.types import Pattern, PatternStatus
from arceus.core.hippocampus.utils.similarity import cosine_similarity


class SQLitePatternStore:
    """Wraps RelationalStore and adds embedding-based find_similar()."""

    def __init__(self, relational: RelationalStore, agent_id: str) -> None:
        self._relational = relational
        self._agent_id = agent_id

    async def insert(self, pattern: Pattern) -> None:
        await self._relational.insert_pattern(pattern)

    async def update(self, pattern: Pattern) -> None:
        if pattern.agent_id != self._agent_id:
            raise PermissionError(
                f"Pattern {pattern.id} belongs to agent {pattern.agent_id}, "
                f"not {self._agent_id}"
            )
        await self._relational.update_pattern(pattern)

    async def find_similar(
        self,
        embedding: list[float],
        threshold: float,
    ) -> Pattern | None:
        all_patterns = await self._relational.list_patterns(self._agent_id)
        best: Pattern | None = None
        best_sim = -1.0
        for pattern in all_patterns:
            if pattern.status != PatternStatus.ACTIVE or not pattern.embedding:
                continue
            sim = cosine_similarity(embedding, pattern.embedding)
            if sim >= threshold and sim > best_sim:
                best = pattern
                best_sim = sim
        return best

    async def list_all(self) -> list[Pattern]:
        return await self._relational.list_patterns(self._agent_id)

    async def update_status(
        self,
        pattern_id: str,
        status: PatternStatus,
    ) -> None:
        all_patterns = await self._relational.list_patterns(self._agent_id)
        if not any(p.id == pattern_id for p in all_patterns):
            raise PermissionError(
                f"Pattern {pattern_id} does not belong to agent {self._agent_id}"
            )
        await self._relational.update_pattern_status(pattern_id, status)
