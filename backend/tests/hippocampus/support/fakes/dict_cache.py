from __future__ import annotations

import asyncio
import json
from collections.abc import Callable


class DictCacheStore:
    """In-process cache with TTL support for tests."""

    def __init__(self, time_fn: Callable[[], float] | None = None) -> None:
        self._items: dict[str, tuple[str, float | None]] = {}
        self._time_fn = time_fn or __import__("time").time
        self._append_locks: dict[str, asyncio.Lock] = {}

    async def get(self, key: str) -> str | None:
        item = self._items.get(key)
        if item is None:
            return None

        value, expires_at = item
        if expires_at is not None and self._time_fn() >= expires_at:
            self._items.pop(key, None)
            return None
        return value

    async def set(self, key: str, value: str, ttl_seconds: int = 3600) -> None:
        expires_at = self._time_fn() + ttl_seconds if ttl_seconds > 0 else None
        self._items[key] = (value, expires_at)

    async def append(self, key: str, value: str, ttl_seconds: int = 3600) -> None:
        lock = self._append_locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            self._append_locks[key] = lock
        async with lock:
            existing = await self.get(key) or "[]"
            items = json.loads(existing)
            items.append(json.loads(value))
            await self.set(key, json.dumps(items, default=str), ttl_seconds=ttl_seconds)

    async def delete(self, key: str) -> None:
        self._items.pop(key, None)
        self._append_locks.pop(key, None)

    async def get_all(self, prefix: str) -> dict[str, str]:
        keys = [key for key in self._items if key.startswith(prefix)]
        values: dict[str, str] = {}
        for key in keys:
            value = await self.get(key)
            if value is not None:
                values[key] = value
        return values

    async def clear(self, prefix: str) -> None:
        for key in list(self._items):
            if key.startswith(prefix):
                self._items.pop(key, None)
                self._append_locks.pop(key, None)
