from __future__ import annotations

import asyncio
import json

from arceus.core.hippocampus.backends.protocols import WorkingMemoryBackend


class WorkingMemory:
    """Tier 1 working memory backed by the cache backend."""

    def __init__(self, agent_id: str, backend: WorkingMemoryBackend) -> None:
        self._agent_id = agent_id
        self._backend = backend
        self._prefix = f"wm:{agent_id}"
        self._conversation_locks: dict[str, asyncio.Lock] = {}

    async def load_task_context(self, task_id: str, context: dict) -> None:
        key = f"{self._prefix}:task:{task_id}"
        await self._backend.set(key, json.dumps(context, default=str), ttl_seconds=7200)

    async def append_conversation(self, task_id: str, message: dict) -> None:
        key = f"{self._prefix}:conv:{task_id}"
        async with self._conversation_lock(key):
            existing = await self._backend.get(key) or "[]"
            messages = json.loads(existing)
            messages.append(message)
            await self._backend.set(key, json.dumps(messages, default=str), ttl_seconds=7200)

    async def get_current_context(self, task_id: str) -> dict:
        task = await self._backend.get(f"{self._prefix}:task:{task_id}")
        conversation = await self._backend.get(f"{self._prefix}:conv:{task_id}")
        scratchpad = await self._backend.get(f"{self._prefix}:scratch:{task_id}")
        return {
            "task": None if task is None else json.loads(task),
            "conversation": None if conversation is None else json.loads(conversation),
            "scratchpad": None if scratchpad is None else json.loads(scratchpad),
        }

    async def set_scratchpad(self, task_id: str, data: dict) -> None:
        key = f"{self._prefix}:scratch:{task_id}"
        await self._backend.set(key, json.dumps(data, default=str), ttl_seconds=7200)

    async def clear_task(self, task_id: str) -> None:
        await self._backend.clear(f"{self._prefix}:task:{task_id}")
        conv_key = f"{self._prefix}:conv:{task_id}"
        await self._backend.clear(conv_key)
        await self._backend.clear(f"{self._prefix}:scratch:{task_id}")
        self._conversation_locks.pop(conv_key, None)

    def _conversation_lock(self, key: str) -> asyncio.Lock:
        lock = self._conversation_locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            self._conversation_locks[key] = lock
        return lock
