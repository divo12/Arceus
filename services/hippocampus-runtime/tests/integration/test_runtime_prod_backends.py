from __future__ import annotations

import asyncio
import json
import os
import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from uuid import uuid4

import asyncpg
import pytest
from neo4j import AsyncGraphDatabase
from redis import asyncio as redis_asyncio


RUNTIME_ROOT = Path(__file__).resolve().parents[2]
RUNTIME_SRC = RUNTIME_ROOT / "python" / "src"
RUNTIME_MODULE = "arceus.core.hippocampus.runtime"

if str(RUNTIME_SRC) not in sys.path:
    sys.path.insert(0, str(RUNTIME_SRC))

from arceus.core.hippocampus.backends.redis_cache import RedisCacheStore
from arceus.core.hippocampus.tiers.working import WorkingMemory


DEFAULT_POSTGRES_URL = os.getenv(
    "HIPPOCAMPUS_RUNTIME_TEST_POSTGRES_URL",
    os.getenv(
        "ARCEUS_HIPPOCAMPUS_POSTGRES_URL",
        "postgresql://hippocampus:hippocampus@127.0.0.1:5433/hippocampus",
    ),
)
DEFAULT_REDIS_URL = os.getenv(
    "HIPPOCAMPUS_RUNTIME_TEST_REDIS_URL",
    os.getenv("ARCEUS_HIPPOCAMPUS_REDIS_URL", "redis://127.0.0.1:6379/0"),
)
DEFAULT_NEO4J_URI = os.getenv(
    "HIPPOCAMPUS_RUNTIME_TEST_NEO4J_URI",
    os.getenv("ARCEUS_NEO4J_URI", "bolt://127.0.0.1:7687"),
)
DEFAULT_NEO4J_USERNAME = os.getenv(
    "HIPPOCAMPUS_RUNTIME_TEST_NEO4J_USERNAME",
    os.getenv("ARCEUS_NEO4J_USERNAME", "neo4j"),
)
DEFAULT_NEO4J_PASSWORD = os.getenv(
    "HIPPOCAMPUS_RUNTIME_TEST_NEO4J_PASSWORD",
    os.getenv("ARCEUS_NEO4J_PASSWORD", "password"),
)
DEFAULT_NEO4J_DATABASE = os.getenv(
    "HIPPOCAMPUS_RUNTIME_TEST_NEO4J_DATABASE",
    os.getenv("ARCEUS_NEO4J_DATABASE", "neo4j"),
)


def _unique_suffix() -> str:
    return uuid4().hex[:8]


async def _read_json_line(
    proc: asyncio.subprocess.Process,
    *,
    timeout: float = 10.0,
) -> dict:
    line = await asyncio.wait_for(proc.stdout.readline(), timeout=timeout)
    if not line:
        stderr = await proc.stderr.read()
        raise AssertionError(
            "Runtime produced no stdout response.\n"
            f"stderr:\n{stderr.decode('utf-8', errors='replace')}"
        )
    return json.loads(line.decode("utf-8"))


async def _rpc(
    proc: asyncio.subprocess.Process,
    request_id: int,
    method: str,
    params: dict | None = None,
) -> dict:
    payload = {
        "jsonrpc": "2.0",
        "id": request_id,
        "method": method,
        "params": params or {},
    }
    proc.stdin.write((json.dumps(payload) + "\n").encode("utf-8"))
    await proc.stdin.drain()
    return await _read_json_line(proc)


def _write_fake_sentence_transformers(base_dir: Path, *, dimensions: int) -> Path:
    package_dir = base_dir / "sentence_transformers"
    package_dir.mkdir(parents=True, exist_ok=True)
    module_path = package_dir / "__init__.py"
    module_path.write_text(
        f"""
import hashlib
import math

_DIMENSIONS = {dimensions}


def _embed(text, normalize_embeddings=True):
    seed = hashlib.sha256(str(text).encode("utf-8")).digest()
    values = []
    counter = 0
    while len(values) < _DIMENSIONS:
        block = hashlib.sha256(seed + counter.to_bytes(4, "big")).digest()
        for byte in block:
            values.append((byte / 127.5) - 1.0)
            if len(values) == _DIMENSIONS:
                break
        counter += 1
    if normalize_embeddings:
        norm = math.sqrt(sum(value * value for value in values)) or 1.0
        values = [value / norm for value in values]
    return values


class SentenceTransformer:
    def __init__(self, model_name, device="cpu"):
        self.model_name = model_name
        self.device = device

    def encode(self, inputs, normalize_embeddings=True):
        if isinstance(inputs, str):
            return _embed(inputs, normalize_embeddings=normalize_embeddings)
        return [
            _embed(item, normalize_embeddings=normalize_embeddings)
            for item in inputs
        ]
""".strip()
        + "\n",
        encoding="utf-8",
    )
    return base_dir


async def _require_postgres(url: str) -> None:
    try:
        conn = await asyncpg.connect(url)
    except Exception as exc:  # pragma: no cover - environment probe
        pytest.skip(f"PostgreSQL is not reachable for integration test: {exc}")
    else:
        await conn.close()


async def _require_redis(url: str) -> None:
    client = redis_asyncio.from_url(url, decode_responses=True)
    try:
        await client.ping()
    except Exception as exc:  # pragma: no cover - environment probe
        pytest.skip(f"Redis is not reachable for integration test: {exc}")
    finally:
        await client.aclose()


async def _require_neo4j(uri: str, username: str, password: str, database: str) -> None:
    driver = AsyncGraphDatabase.driver(uri, auth=(username, password))
    try:
        await driver.verify_connectivity()
        async with driver.session(database=database or None) as session:
            result = await session.run("RETURN 1 AS ok")
            await result.single()
    except Exception as exc:  # pragma: no cover - environment probe
        pytest.skip(f"Neo4j is not reachable for integration test: {exc}")
    finally:
        await driver.close()


@asynccontextmanager
async def spawn_runtime_with_prod_backends(
    tmp_path: Path,
    *,
    postgres_url: str,
    postgres_schema: str,
    redis_url: str,
    neo4j_uri: str,
    neo4j_username: str,
    neo4j_password: str,
    neo4j_database: str,
    embedding_dimensions: int = 384,
) -> AsyncIterator[asyncio.subprocess.Process]:
    fake_modules_dir = _write_fake_sentence_transformers(
        tmp_path / "fake-modules",
        dimensions=embedding_dimensions,
    )

    env = os.environ.copy()
    pythonpath_parts = [str(fake_modules_dir), str(RUNTIME_SRC)]
    existing_pythonpath = env.get("PYTHONPATH")
    if existing_pythonpath:
        pythonpath_parts.append(existing_pythonpath)
    env["PYTHONPATH"] = os.pathsep.join(pythonpath_parts)
    env["PYTHONUNBUFFERED"] = "1"
    env["ARCEUS_HIPPOCAMPUS_POSTGRES_URL"] = postgres_url
    env["ARCEUS_HIPPOCAMPUS_POSTGRES_SCHEMA"] = postgres_schema
    env["ARCEUS_HIPPOCAMPUS_REDIS_URL"] = redis_url
    env["ARCEUS_NEO4J_URI"] = neo4j_uri
    env["ARCEUS_NEO4J_USERNAME"] = neo4j_username
    env["ARCEUS_NEO4J_PASSWORD"] = neo4j_password
    env["ARCEUS_NEO4J_DATABASE"] = neo4j_database
    env["ARCEUS_AZURE_OPENAI_ENDPOINT"] = "https://example.openai.azure.com/"
    env["ARCEUS_AZURE_OPENAI_API_KEY"] = "test-key"
    env["ARCEUS_AZURE_OPENAI_API_VERSION"] = "2025-03-01-preview"
    env["ARCEUS_DEBUG"] = "true"

    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        RUNTIME_MODULE,
        cwd=str(RUNTIME_ROOT),
        env=env,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        yield proc
    finally:
        if proc.returncode is None:
            try:
                await _rpc(proc, 9999, "shutdown")
            except Exception:
                proc.kill()
            try:
                await asyncio.wait_for(proc.wait(), timeout=10.0)
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()


@pytest.mark.asyncio
async def test_runtime_stdio_uses_postgres_and_neo4j_backends(
    tmp_path: Path,
) -> None:
    postgres_url = DEFAULT_POSTGRES_URL
    neo4j_uri = DEFAULT_NEO4J_URI
    neo4j_username = DEFAULT_NEO4J_USERNAME
    neo4j_password = DEFAULT_NEO4J_PASSWORD
    neo4j_database = DEFAULT_NEO4J_DATABASE

    await _require_postgres(postgres_url)
    await _require_neo4j(
        neo4j_uri,
        neo4j_username,
        neo4j_password,
        neo4j_database,
    )

    schema_name = f"hippo_rt_{_unique_suffix()}"
    container = f"startup:runtime-it:{_unique_suffix()}"
    agent_id = f"agent-{_unique_suffix()}"
    content = "Security review required before launch"

    neo4j_driver = AsyncGraphDatabase.driver(
        neo4j_uri,
        auth=(neo4j_username, neo4j_password),
    )
    try:
        async with spawn_runtime_with_prod_backends(
            tmp_path,
            postgres_url=postgres_url,
            postgres_schema=schema_name,
            redis_url=DEFAULT_REDIS_URL,
            neo4j_uri=neo4j_uri,
            neo4j_username=neo4j_username,
            neo4j_password=neo4j_password,
            neo4j_database=neo4j_database,
        ) as proc:
            health = await _rpc(proc, 1, "health")
            assert health["result"] == {
                "status": "ok",
                "agents_loaded": 0,
                "debug": True,
            }

            remembered = await _rpc(
                proc,
                2,
                "remember",
                {
                    "agent_id": agent_id,
                    "content": content,
                    "container": container,
                    "memory_type": "dynamic",
                },
            )
            memory_id = remembered["result"]["id"]
            assert remembered["result"]["content"] == content
            assert remembered["result"]["memory_type"] == "dynamic"

            recalled = await _rpc(
                proc,
                3,
                "recall",
                {
                    "agent_id": agent_id,
                    "query": content,
                    "container": container,
                    "top_k": 5,
                    "include_graph": False,
                },
            )
            assert recalled["result"]["items"]
            assert recalled["result"]["items"][0]["id"] == memory_id
            assert recalled["result"]["items"][0]["content"] == content

            listed = await _rpc(
                proc,
                4,
                "listMemories",
                {
                    "agent_id": agent_id,
                    "container": container,
                    "limit": 10,
                },
            )
            assert listed["result"]["total"] >= 1
            assert any(item["id"] == memory_id for item in listed["result"]["items"])

            health_after = await _rpc(proc, 5, "health")
            assert health_after["result"]["agents_loaded"] == 1

        conn = await asyncpg.connect(postgres_url)
        try:
            row_count = await conn.fetchval(
                f'SELECT COUNT(*) FROM "{schema_name}".memory_units WHERE agent_id = $1 AND container = $2',
                agent_id,
                container,
            )
        finally:
            await conn.execute(f'DROP SCHEMA IF EXISTS "{schema_name}" CASCADE')
            await conn.close()

        assert row_count == 1

        async with neo4j_driver.session(database=neo4j_database or None) as session:
            result = await session.run(
                """
                MATCH (n:GraphEntity)
                WHERE n.container = $container AND n.agent_id = $agent_id
                RETURN count(n) AS count
                """,
                container=container,
                agent_id=agent_id,
            )
            record = await result.single()
            node_count = int(record["count"]) if record is not None else 0
            await session.run(
                """
                MATCH (n:GraphEntity)
                WHERE n.container = $container AND n.agent_id = $agent_id
                DETACH DELETE n
                """,
                container=container,
                agent_id=agent_id,
            )

        assert node_count >= 1
    finally:
        await neo4j_driver.close()


@pytest.mark.asyncio
async def test_working_memory_round_trip_uses_real_redis_backend() -> None:
    redis_url = DEFAULT_REDIS_URL
    await _require_redis(redis_url)

    agent_id = f"agent-{_unique_suffix()}"
    task_id = f"task-{_unique_suffix()}"
    backend = RedisCacheStore(redis_url=redis_url)
    memory = WorkingMemory(agent_id=agent_id, backend=backend)

    try:
        await memory.load_task_context(task_id, {"issue": "release gate", "attempt": 1})
        await memory.append_conversation(
            task_id,
            {"role": "assistant", "content": "Remember to verify Postgres migrations."},
        )
        await memory.append_conversation(
            task_id,
            {"role": "user", "content": "Also verify Redis and Neo4j connectivity."},
        )

        context = await memory.get_current_context(task_id)

        assert context["task"] == {"issue": "release gate", "attempt": 1}
        assert context["conversation"] == [
            {"role": "assistant", "content": "Remember to verify Postgres migrations."},
            {"role": "user", "content": "Also verify Redis and Neo4j connectivity."},
        ]

        await memory.clear_task(task_id)
        cleared = await memory.get_current_context(task_id)
        assert cleared == {
            "task": None,
            "conversation": None,
            "scratchpad": None,
        }
    finally:
        await backend.close()
