from __future__ import annotations

import inspect
import json
from collections.abc import AsyncIterator
from typing import Any

from arceus.config.settings import settings


class RedisCacheStore:
    """Redis-backed working memory cache with TTL and prefix operations."""

    def __init__(self, redis_url: str = "", client: Any | None = None) -> None:
        self._redis_url = redis_url or settings.hippocampus_redis_url or settings.redis_url
        self._client = client

    async def get(self, key: str) -> str | None:
        client = await self._get_client()
        key_type = await self._key_type(client, key)
        if key_type == "list":
            items = await client.lrange(key, 0, -1)
            if not items:
                return None
            payload: list[object] = []
            for item in items:
                if isinstance(item, bytes):
                    item = item.decode()
                if isinstance(item, str):
                    try:
                        payload.append(json.loads(item))
                    except json.JSONDecodeError:
                        payload.append(item)
                else:
                    payload.append(item)
            return json.dumps(payload, default=str)
        value = await client.get(key)
        if value is None:
            return None
        if isinstance(value, bytes):
            return value.decode()
        return str(value)

    async def set(self, key: str, value: str, ttl_seconds: int = 3600) -> None:
        client = await self._get_client()
        if ttl_seconds > 0:
            await client.set(key, value, ex=ttl_seconds)
            return
        await client.set(key, value)

    async def append(self, key: str, value: str, ttl_seconds: int = 3600) -> None:
        client = await self._get_client()
        await client.rpush(key, value)
        if ttl_seconds > 0:
            await client.expire(key, ttl_seconds)

    async def delete(self, key: str) -> None:
        client = await self._get_client()
        await client.delete(key)

    async def get_all(self, prefix: str) -> dict[str, str]:
        client = await self._get_client()
        values: dict[str, str] = {}
        async for key in self._scan_keys(client, f"{prefix}*"):
            value = await self.get(key)
            if value is not None:
                values[key] = value
        return values

    async def clear(self, prefix: str) -> None:
        client = await self._get_client()
        keys = [key async for key in self._scan_keys(client, f"{prefix}*")]
        if keys:
            await client.delete(*keys)

    async def close(self) -> None:
        if self._client is None:
            return

        close = getattr(self._client, "aclose", None)
        if callable(close):
            await close()
            self._client = None
            return

        close = getattr(self._client, "close", None)
        if callable(close):
            result = close()
            if inspect.isawaitable(result):
                await result
        self._client = None

    async def _get_client(self) -> Any:
        if self._client is not None:
            return self._client

        from redis import asyncio as redis_asyncio

        self._client = redis_asyncio.from_url(
            self._redis_url,
            decode_responses=True,
        )
        return self._client

    async def _scan_keys(self, client: Any, pattern: str) -> AsyncIterator[str]:
        cursor = 0
        while True:
            cursor, keys = await client.scan(cursor=cursor, match=pattern)
            for key in keys:
                if isinstance(key, bytes):
                    yield key.decode()
                else:
                    yield str(key)
            if cursor == 0:
                break

    async def _key_type(self, client: Any, key: str) -> str:
        key_type = await client.type(key)
        if isinstance(key_type, bytes):
            return key_type.decode()
        return str(key_type)
