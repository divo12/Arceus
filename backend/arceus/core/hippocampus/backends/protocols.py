from __future__ import annotations

from datetime import datetime
from typing import Protocol

from arceus.core.hippocampus.types import (
    GraphEntity,
    GraphRelationship,
    Habit,
    MemoryType,
    MemoryUnit,
    Pattern,
    PatternStatus,
)


class VectorStore(Protocol):
    async def upsert(self, unit: MemoryUnit) -> None: ...

    async def get(self, memory_id: str) -> MemoryUnit | None: ...

    async def search(
        self,
        embedding: list[float],
        container: str,
        memory_types: list[MemoryType] | None = None,
        top_k: int = 10,
    ) -> list[MemoryUnit]: ...

    async def list_by_type(
        self,
        agent_id: str,
        memory_type: MemoryType | None = None,
        memory_types: list[MemoryType] | None = None,
        container: str | None = None,
        created_after: datetime | None = None,
    ) -> list[MemoryUnit]: ...

    async def soft_delete(self, memory_id: str, reason: str = "") -> None: ...

    async def find_expired(
        self,
        agent_id: str,
        memory_type: MemoryType,
        before: datetime,
    ) -> list[MemoryUnit]: ...


class WorkingMemoryBackend(Protocol):
    async def get(self, key: str) -> str | None: ...

    async def set(self, key: str, value: str, ttl_seconds: int = 3600) -> None: ...

    async def delete(self, key: str) -> None: ...

    async def get_all(self, prefix: str) -> dict[str, str]: ...

    async def clear(self, prefix: str) -> None: ...


class RelationalStore(Protocol):
    async def initialize(self) -> None: ...

    async def close(self) -> None: ...

    async def insert_habit(self, habit: Habit) -> None: ...

    async def get_habit(self, habit_id: str) -> Habit: ...

    async def list_habits(self, agent_id: str, is_active: bool = True) -> list[Habit]: ...

    async def update_habit(self, habit: Habit) -> None: ...

    async def set_priming_state(self, agent_id: str, state: dict) -> None: ...

    async def get_priming_state(self, agent_id: str) -> dict | None: ...

    async def insert_pattern(self, pattern: Pattern) -> None: ...

    async def update_pattern(self, pattern: Pattern) -> None: ...

    async def list_patterns(self, agent_id: str) -> list[Pattern]: ...

    async def update_pattern_status(self, pattern_id: str, status: PatternStatus) -> None: ...


class PatternStore(Protocol):
    async def insert(self, pattern: Pattern) -> None: ...

    async def update(self, pattern: Pattern) -> None: ...

    async def find_similar(self, embedding: list[float], threshold: float) -> Pattern | None: ...

    async def list_all(self, agent_id: str) -> list[Pattern]: ...

    async def update_status(self, pattern_id: str, status: PatternStatus) -> None: ...


class GraphStoreBackend(Protocol):
    async def close(self) -> None: ...

    async def create_node(self, entity: GraphEntity) -> str: ...

    async def get_node(self, node_id: str) -> GraphEntity | None: ...

    async def update_node(self, node_id: str, updates: dict) -> None: ...

    async def create_edge(self, rel: GraphRelationship) -> str: ...

    async def vector_search(
        self,
        embedding: list[float],
        container: str,
        top_k: int,
    ) -> list[GraphEntity]: ...

    async def get_neighbors(
        self,
        node_id: str,
        max_hops: int,
        relation_types: list[str] | None = None,
    ) -> list[GraphEntity]: ...

    async def cypher_query(self, query: str, params: dict) -> list[GraphEntity]: ...


class LLMEngine(Protocol):
    async def extract_structured(
        self,
        prompt: str,
        messages: list[dict],
        output_schema: type,
    ) -> list: ...

    async def decide(self, prompt: str, **kwargs) -> dict: ...

    async def analyze(self, prompt: str, **kwargs) -> dict: ...

    async def generate(self, prompt: str, **kwargs) -> str: ...

    async def classify(self, prompt: str, options: list[str], **kwargs) -> str: ...


class EmbeddingEngine(Protocol):
    async def embed(self, text: str) -> list[float]: ...

    async def embed_batch(self, texts: list[str]) -> list[list[float]]: ...
