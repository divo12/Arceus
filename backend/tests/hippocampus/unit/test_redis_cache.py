from __future__ import annotations

import fnmatch

import pytest

from arceus.core.hippocampus.backends.redis_cache import RedisCacheStore


class FakeRedisClient:
    def __init__(self) -> None:
        self._items: dict[str, tuple[str, int | None]] = {}
        self._lists: dict[str, tuple[list[str], int | None]] = {}
        self._now = 100
        self.closed = False
        self.scan_calls: list[tuple[int, str | None]] = []

    async def get(self, key: str) -> str | None:
        item = self._items.get(key)
        if item is None:
            return None
        value, expires_at = item
        if expires_at is not None and self._now >= expires_at:
            self._items.pop(key, None)
            return None
        return value

    async def set(self, key: str, value: str, ex: int | None = None) -> None:
        expires_at = self._now + ex if ex is not None else None
        self._lists.pop(key, None)
        self._items[key] = (value, expires_at)

    async def rpush(self, key: str, value: str) -> None:
        items, expires_at = self._lists.get(key, ([], None))
        if expires_at is not None and self._now >= expires_at:
            items = []
            expires_at = None
        items = [*items, value]
        self._items.pop(key, None)
        self._lists[key] = (items, expires_at)

    async def expire(self, key: str, ttl_seconds: int) -> None:
        expires_at = self._now + ttl_seconds
        if key in self._items:
            value, _ = self._items[key]
            self._items[key] = (value, expires_at)
        if key in self._lists:
            values, _ = self._lists[key]
            self._lists[key] = (values, expires_at)

    async def lrange(self, key: str, start: int, end: int) -> list[str]:
        del start
        items = self._lists.get(key)
        if items is None:
            return []
        values, expires_at = items
        if expires_at is not None and self._now >= expires_at:
            self._lists.pop(key, None)
            return []
        if end == -1:
            return list(values)
        return list(values[: end + 1])

    async def type(self, key: str) -> str:
        if key in self._lists:
            values, expires_at = self._lists[key]
            if expires_at is not None and self._now >= expires_at:
                self._lists.pop(key, None)
            else:
                return "list"
        if key in self._items:
            value, expires_at = self._items[key]
            del value
            if expires_at is not None and self._now >= expires_at:
                self._items.pop(key, None)
            else:
                return "string"
        return "none"

    async def delete(self, *keys: str) -> None:
        for key in keys:
            self._items.pop(key, None)
            self._lists.pop(key, None)

    async def scan(
        self,
        cursor: int = 0,
        match: str | None = None,
    ) -> tuple[int, list[str]]:
        self.scan_calls.append((cursor, match))
        all_keys = sorted(set(self._items) | set(self._lists))
        matching = [
            key for key in all_keys if match is None or fnmatch.fnmatch(key, match)
        ]
        if cursor >= len(matching):
            return 0, []
        batch = matching[cursor : cursor + 2]
        next_cursor = cursor + 2
        if next_cursor >= len(matching):
            next_cursor = 0
        return next_cursor, batch

    async def aclose(self) -> None:
        self.closed = True


@pytest.mark.asyncio
async def test_redis_cache_store_respects_ttl_and_prefix_clear() -> None:
    client = FakeRedisClient()
    store = RedisCacheStore(client=client)

    await store.set("wm:task:1", "payload", ttl_seconds=10)
    assert await store.get("wm:task:1") == "payload"

    client._now = 111
    assert await store.get("wm:task:1") is None

    await store.set("wm:task:2", "task", ttl_seconds=100)
    await store.set("wm:conv:2", "conversation", ttl_seconds=100)

    assert await store.get_all("wm:") == {
        "wm:conv:2": "conversation",
        "wm:task:2": "task",
    }

    await store.clear("wm:")
    assert await store.get_all("wm:") == {}


@pytest.mark.asyncio
async def test_redis_cache_store_uses_scan_for_prefix_operations() -> None:
    client = FakeRedisClient()
    store = RedisCacheStore(client=client)

    await store.set("wm:task:1", "task", ttl_seconds=100)
    await store.set("wm:conv:1", "conversation", ttl_seconds=100)
    await store.get_all("wm:")
    await store.clear("wm:")

    assert client.scan_calls == [
        (0, "wm:*"),
        (0, "wm:*"),
    ]


@pytest.mark.asyncio
async def test_redis_cache_store_close_closes_client() -> None:
    client = FakeRedisClient()
    store = RedisCacheStore(client=client)

    await store.close()

    assert client.closed is True


@pytest.mark.asyncio
async def test_redis_cache_store_append_materializes_json_conversation() -> None:
    client = FakeRedisClient()
    store = RedisCacheStore(client=client)

    await store.append("wm:conv:1", '{"role":"user","content":"hello"}', ttl_seconds=30)
    await store.append("wm:conv:1", '{"role":"assistant","content":"hi"}', ttl_seconds=30)

    assert await store.get("wm:conv:1") == (
        '[{"role": "user", "content": "hello"}, {"role": "assistant", "content": "hi"}]'
    )
