from __future__ import annotations

import asyncio
import json
import os
import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import pytest


RUNTIME_ROOT = Path(__file__).resolve().parents[2]
RUNTIME_SRC = RUNTIME_ROOT / "python" / "src"
RUNTIME_MODULE = "arceus.core.hippocampus.runtime"


async def _read_json_line(
    proc: asyncio.subprocess.Process,
    *,
    timeout: float = 5.0,
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


@asynccontextmanager
async def spawn_runtime(tmp_path: Path) -> AsyncIterator[asyncio.subprocess.Process]:
    env = os.environ.copy()
    existing_pythonpath = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = (
        f"{RUNTIME_SRC}{os.pathsep}{existing_pythonpath}"
        if existing_pythonpath
        else str(RUNTIME_SRC)
    )
    env["PYTHONUNBUFFERED"] = "1"
    env["ARCEUS_HIPPOCAMPUS_PROFILE"] = "test_fakes"
    env["ARCEUS_HIPPOCAMPUS_TEST_DIR"] = str(tmp_path)
    env["ARCEUS_HIPPOCAMPUS_TEST_EMBEDDING_DIMENSIONS"] = "32"

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
                await asyncio.wait_for(proc.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()


@pytest.mark.asyncio
async def test_runtime_stdio_exposes_memory_surface_and_reuses_agent_instances(
    tmp_path: Path,
) -> None:
    async with spawn_runtime(tmp_path) as proc:
        response = await _rpc(proc, 1, "health")
        assert response["result"] == {
            "status": "ok",
            "agents_loaded": 0,
            "debug": False,
        }

        remembered = await _rpc(
            proc,
            2,
            "remember",
            {
                "agent_id": "agent-1",
                "content": "JWT is the default auth strategy",
                "container": "startup:acme",
                "memory_type": "dynamic",
            },
        )
        assert remembered["result"]["content"] == "JWT is the default auth strategy"
        assert remembered["result"]["memory_type"] == "dynamic"

        await _rpc(
            proc,
            3,
            "remember",
            {
                "agent_id": "agent-1",
                "content": "We deploy with blue green rollouts",
                "container": "startup:acme",
                "memory_type": "static",
            },
        )
        await _rpc(
            proc,
            4,
            "remember",
            {
                "agent_id": "agent-2",
                "content": "Secret note for agent 2",
                "container": "startup:acme",
                "memory_type": "dynamic",
            },
        )

        health_after = await _rpc(proc, 5, "health")
        assert health_after["result"]["agents_loaded"] == 2

        recall = await _rpc(
            proc,
            6,
            "recall",
            {
                "agent_id": "agent-1",
                "query": "JWT auth",
                "container": "startup:acme",
                "top_k": 5,
                "include_graph": False,
            },
        )
        recalled_contents = [item["content"] for item in recall["result"]["items"]]
        assert "JWT is the default auth strategy" in recalled_contents
        assert "Secret note for agent 2" not in recalled_contents

        extract = await _rpc(
            proc,
            7,
            "extract",
            {
                "agent_id": "agent-1",
                "messages": [
                    {"role": "user", "content": "We should keep this simple."},
                    {"role": "assistant", "content": "Acknowledged."},
                ],
                "container": "startup:acme",
                "mode": "agent",
            },
        )
        assert extract["result"] == {"added": 0, "updated": 0, "deleted": 0}

        trajectory = await _rpc(
            proc,
            8,
            "processTrajectory",
            {
                "agent_id": "agent-1",
                "task_id": "task-1",
                "outcome": "succeeded",
                "quality": 0.9,
                "container": "startup:acme",
                "steps": [
                    {
                        "action": "inspect migrations",
                        "result": "validated",
                    }
                ],
            },
        )
        assert set(trajectory["result"]) == {"verdict", "distilled", "pattern", "habit"}

        priming = await _rpc(proc, 9, "getPriming", {"agent_id": "agent-1"})
        assert isinstance(priming["result"]["prompt"], str)

        habits = await _rpc(
            proc,
            10,
            "getHabits",
            {"agent_id": "agent-1", "context": "deploy auth changes"},
        )
        assert habits["result"] == {"habits": []}

        summary = await _rpc(
            proc,
            11,
            "getSummary",
            {"agent_id": "agent-1", "container": "startup:acme"},
        )
        assert summary["result"]["total_static"] == 1
        assert summary["result"]["total_dynamic"] >= 1
        assert "priming_prompt" in summary["result"]

        memories = await _rpc(
            proc,
            12,
            "listMemories",
            {"agent_id": "agent-1", "container": "startup:acme", "limit": 10},
        )
        assert memories["result"]["total"] >= 2
        assert all(item["content"] != "Secret note for agent 2" for item in memories["result"]["items"])

        gc = await _rpc(proc, 13, "runGC", {"agent_id": "agent-1"})
        assert {"expired", "decayed", "demoted"} <= set(gc["result"])

        promotions = await _rpc(proc, 14, "runPromotions", {"agent_id": "agent-1"})
        assert promotions["result"]["promotions"] == []


@pytest.mark.asyncio
async def test_runtime_stdio_returns_parse_error_for_malformed_json(
    tmp_path: Path,
) -> None:
    async with spawn_runtime(tmp_path) as proc:
        proc.stdin.write(b"{not valid json}\n")
        await proc.stdin.drain()

        response = await _read_json_line(proc)

        assert response["error"]["code"] == -32700
        assert response["id"] is None


@pytest.mark.asyncio
async def test_runtime_stdio_returns_method_not_found_for_unknown_method(
    tmp_path: Path,
) -> None:
    async with spawn_runtime(tmp_path) as proc:
        response = await _rpc(proc, 15, "unknownMethod", {})

        assert response["error"]["code"] == -32601
        assert response["id"] == 15


@pytest.mark.asyncio
async def test_runtime_stdio_serializes_handler_exceptions(
    tmp_path: Path,
) -> None:
    async with spawn_runtime(tmp_path) as proc:
        response = await _rpc(
            proc,
            16,
            "remember",
            {
                "agent_id": "agent-1",
                "content": "Broken memory type",
                "container": "startup:acme",
                "memory_type": "not-a-memory-type",
            },
        )

        assert response["error"]["code"] == -32602
        assert response["error"]["data"]["type"] == "ValueError"
        assert response["id"] == 16


@pytest.mark.asyncio
async def test_runtime_stdio_shutdown_exits_cleanly(
    tmp_path: Path,
) -> None:
    async with spawn_runtime(tmp_path) as proc:
        response = await _rpc(proc, 17, "shutdown")

        assert response["result"]["status"] == "stopping"
        exit_code = await asyncio.wait_for(proc.wait(), timeout=5.0)
        assert exit_code == 0
