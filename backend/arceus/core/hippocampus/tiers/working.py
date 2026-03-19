from __future__ import annotations

from arceus.core.hippocampus.backends.protocols import WorkingMemoryBackend
from arceus.core.hippocampus.utils.serialization import deserialize, serialize


class WorkingMemory:
    """Tier 1 working memory backed by the cache backend."""

    def __init__(self, agent_id: str, backend: WorkingMemoryBackend) -> None:
        self._agent_id = agent_id
        self._backend = backend
        self._prefix = f"wm:{agent_id}"

    async def load_task_context(self, task_id: str, context: dict) -> None:
        key = f"{self._prefix}:task:{task_id}"
        await self._backend.set(key, serialize(context), ttl_seconds=7200)

    async def append_conversation(self, task_id: str, message: dict) -> None:
        key = f"{self._prefix}:conv:{task_id}"
        existing = await self._backend.get(key) or "[]"
        messages = deserialize(existing)
        messages.append(message)
        await self._backend.set(key, serialize(messages), ttl_seconds=7200)

    async def get_current_context(self, task_id: str) -> dict:
        task = await self._backend.get(f"{self._prefix}:task:{task_id}")
        conversation = await self._backend.get(f"{self._prefix}:conv:{task_id}")
        scratchpad = await self._backend.get(f"{self._prefix}:scratch:{task_id}")
        return {
            "task": None if task is None else deserialize(task),
            "conversation": None if conversation is None else deserialize(conversation),
            "scratchpad": None if scratchpad is None else deserialize(scratchpad),
        }

    async def clear_task(self, task_id: str) -> None:
        await self._backend.clear(f"{self._prefix}:task:{task_id}")
        await self._backend.clear(f"{self._prefix}:conv:{task_id}")
        await self._backend.clear(f"{self._prefix}:scratch:{task_id}")
