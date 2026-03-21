from __future__ import annotations

import asyncio

import pytest

from arceus.core.hippocampus.backends.redis_cache import RedisCacheStore
from arceus.core.hippocampus.tiers.working import WorkingMemory

pytestmark = [
    pytest.mark.integration,
    pytest.mark.redis,
]


@pytest.mark.asyncio
async def test_redis_cache_store_ttl_and_prefix_clear(
    redis_url: str,
    unique_id: str,
) -> None:
    store = RedisCacheStore(redis_url=redis_url)
    prefix = f"wm:it:{unique_id}"

    await store.set(f"{prefix}:one", "alpha", ttl_seconds=30)
    await store.set(f"{prefix}:two", "beta", ttl_seconds=30)
    assert await store.get(f"{prefix}:one") == "alpha"
    assert await store.get_all(prefix) == {
        f"{prefix}:one": "alpha",
        f"{prefix}:two": "beta",
    }

    await store.clear(prefix)
    assert await store.get_all(prefix) == {}
    await store.close()


@pytest.mark.asyncio
async def test_redis_cache_store_expires_values(
    redis_url: str,
    unique_id: str,
) -> None:
    store = RedisCacheStore(redis_url=redis_url)
    key = f"wm:it:{unique_id}:ttl"

    await store.set(key, "short-lived", ttl_seconds=1)
    await asyncio.sleep(1.2)

    assert await store.get(key) is None
    await store.close()


@pytest.mark.asyncio
async def test_working_memory_parity_against_redis_backend(
    redis_url: str,
    unique_id: str,
) -> None:
    backend = RedisCacheStore(redis_url=redis_url)
    working_memory = WorkingMemory(agent_id=f"agent-{unique_id}", backend=backend)

    await working_memory.load_task_context("task-1", {"goal": "ship sprint 3"})
    await working_memory.append_conversation("task-1", {"role": "user", "content": "go"})
    await working_memory.set_scratchpad("task-1", {"note": "watch redis TTL"})

    current = await working_memory.get_current_context("task-1")
    assert current["task"] == {"goal": "ship sprint 3"}
    assert current["conversation"] == [{"role": "user", "content": "go"}]
    assert current["scratchpad"] == {"note": "watch redis TTL"}

    await working_memory.clear_task("task-1")
    cleared = await working_memory.get_current_context("task-1")
    assert cleared == {"task": None, "conversation": None, "scratchpad": None}

    await backend.close()
