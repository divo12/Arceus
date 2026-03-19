"""Hippocampus — multi-level memory system backed by Mem0.

Three memory tiers:
1. Working Memory  — short-term, per-task context (in-process, not persisted)
2. Episodic Memory — per-agent experiences (Mem0 user-scoped memories)
3. Semantic Memory — org-wide knowledge (Mem0 org-scoped memories)

The Hippocampus coordinates reads/writes across these tiers and handles
consolidation (promoting working → episodic, episodic → semantic).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class WorkingMemory:
    """Short-term context for a single task execution. Not persisted."""

    task_id: str
    agent_id: str
    context: list[dict] = field(default_factory=list)
    tool_results: list[dict] = field(default_factory=list)

    def add(self, key: str, value: Any) -> None:
        self.context.append({"key": key, "value": value})

    def get_context_string(self) -> str:
        return "\n".join(f"- {c['key']}: {c['value']}" for c in self.context)


class Hippocampus:
    """Central memory coordinator."""

    def __init__(self, mem0_client: Any = None):
        self._mem0 = mem0_client
        self._working: dict[str, WorkingMemory] = {}

    # --- Working Memory ---

    def create_working_memory(self, task_id: str, agent_id: str) -> WorkingMemory:
        wm = WorkingMemory(task_id=task_id, agent_id=agent_id)
        self._working[task_id] = wm
        return wm

    def get_working_memory(self, task_id: str) -> WorkingMemory | None:
        return self._working.get(task_id)

    def discard_working_memory(self, task_id: str) -> None:
        self._working.pop(task_id, None)

    # --- Episodic Memory (Mem0 user-scoped) ---

    async def store_episodic(
        self, agent_id: str, content: str, metadata: dict | None = None
    ) -> str:
        """Store an agent-level memory in Mem0."""
        # TODO: call Mem0 client
        # mem0.add(content, user_id=agent_id, metadata=metadata)
        return "mem0_id_placeholder"

    async def retrieve_episodic(
        self, agent_id: str, query: str, limit: int = 5
    ) -> list[dict]:
        """Retrieve relevant agent-level memories."""
        # TODO: call Mem0 client
        # mem0.search(query, user_id=agent_id, limit=limit)
        return []

    # --- Semantic Memory (Mem0 org-scoped) ---

    async def store_semantic(
        self, startup_id: str, content: str, metadata: dict | None = None
    ) -> str:
        """Store an org-wide memory."""
        # TODO: call Mem0 client with org scope
        return "mem0_id_placeholder"

    async def retrieve_semantic(
        self, startup_id: str, query: str, limit: int = 5
    ) -> list[dict]:
        """Retrieve relevant org-wide knowledge."""
        # TODO: call Mem0 client with org scope
        return []

    # --- Consolidation ---

    async def consolidate_working_to_episodic(self, task_id: str) -> None:
        """Post-task: promote key learnings from working memory to episodic."""
        wm = self.get_working_memory(task_id)
        if not wm:
            return
        # TODO: use LLM to summarize working memory → store in episodic
        self.discard_working_memory(task_id)

    async def consolidate_episodic_to_semantic(
        self, agent_id: str, startup_id: str
    ) -> None:
        """Post-standup: promote cross-agent patterns to semantic memory."""
        # TODO: retrieve recent episodic memories
        # Use LLM to find patterns → store in semantic
        pass
