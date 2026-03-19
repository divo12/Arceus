from __future__ import annotations

from arceus.core.hippocampus.types import Pattern, PatternStatus
from arceus.core.hippocampus.utils.similarity import cosine_similarity


class InMemoryPatternStore:
    """In-memory PatternStore for tests."""

    def __init__(self, agent_id: str = "") -> None:
        self._agent_id = agent_id
        self._patterns: dict[str, Pattern] = {}

    async def insert(self, pattern: Pattern) -> None:
        self._patterns[pattern.id] = pattern

    async def update(self, pattern: Pattern) -> None:
        self._patterns[pattern.id] = pattern

    async def find_similar(
        self,
        embedding: list[float],
        threshold: float,
    ) -> Pattern | None:
        best: Pattern | None = None
        best_sim = -1.0
        for pattern in self._patterns.values():
            if pattern.status != PatternStatus.ACTIVE or not pattern.embedding:
                continue
            sim = cosine_similarity(embedding, pattern.embedding)
            if sim >= threshold and sim > best_sim:
                best = pattern
                best_sim = sim
        return best

    async def list_all(self) -> list[Pattern]:
        return [
            pattern for pattern in self._patterns.values()
            if pattern.agent_id == self._agent_id
        ]

    async def update_status(
        self,
        pattern_id: str,
        status: PatternStatus,
    ) -> None:
        existing = self._patterns.get(pattern_id)
        if existing is None:
            return
        updated = Pattern(
            id=existing.id,
            agent_id=existing.agent_id,
            description=existing.description,
            strategy=existing.strategy,
            embedding=existing.embedding,
            usage_count=existing.usage_count,
            success_rate=existing.success_rate,
            formed_from=existing.formed_from,
            cluster_id=existing.cluster_id,
            status=status,
            domain=existing.domain,
            created_at=existing.created_at,
            updated_at=existing.updated_at,
        )
        self._patterns[pattern_id] = updated
