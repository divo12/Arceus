from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

import pytest

RUNTIME_ROOT = Path(__file__).resolve().parents[2]
PYTHON_ROOT = RUNTIME_ROOT / "python"
RUNTIME_SRC = PYTHON_ROOT / "src"


async def _start_runtime(tmp_path: Path) -> asyncio.subprocess.Process:
    env = os.environ.copy()
    env["PYTHONPATH"] = os.pathsep.join(
        [str(RUNTIME_SRC), env["PYTHONPATH"]]
    ) if env.get("PYTHONPATH") else str(RUNTIME_SRC)
    env["ARCEUS_HIPPOCAMPUS_PROFILE"] = "test_fakes"
    env["ARCEUS_HIPPOCAMPUS_SQLITE_PATH"] = str(tmp_path / "hippocampus.db")
    return await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "arceus.core.hippocampus.stdio_rpc",
        cwd=str(PYTHON_ROOT),
        env=env,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )


async def _send_request(
    process: asyncio.subprocess.Process,
    request: dict,
    *,
    timeout: float = 5.0,
) -> dict:
    assert process.stdin is not None
    assert process.stdout is not None
    process.stdin.write((json.dumps(request) + "\n").encode("utf-8"))
    await process.stdin.drain()
    line = await asyncio.wait_for(process.stdout.readline(), timeout=timeout)
    return json.loads(line.decode("utf-8"))


async def _send_raw_line(
    process: asyncio.subprocess.Process,
    line: str,
    *,
    timeout: float = 5.0,
) -> dict:
    assert process.stdin is not None
    assert process.stdout is not None
    process.stdin.write((line + "\n").encode("utf-8"))
    await process.stdin.drain()
    response = await asyncio.wait_for(process.stdout.readline(), timeout=timeout)
    return json.loads(response.decode("utf-8"))


@pytest.mark.asyncio
async def test_stdio_rpc_health_and_shutdown(tmp_path: Path) -> None:
    process = await _start_runtime(tmp_path)

    health = await _send_request(
        process,
        {"jsonrpc": "2.0", "id": 1, "method": "health", "params": {}},
    )
    assert health["result"]["status"] == "ok"
    assert health["result"]["agents_loaded"] == 0

    shutdown = await _send_request(
        process,
        {"jsonrpc": "2.0", "id": 2, "method": "shutdown", "params": {}},
    )
    assert shutdown["result"]["status"] == "stopping"

    exit_code = await asyncio.wait_for(process.wait(), timeout=5.0)
    assert exit_code == 0


@pytest.mark.asyncio
async def test_stdio_rpc_handles_parse_errors(tmp_path: Path) -> None:
    process = await _start_runtime(tmp_path)
    try:
        response = await _send_raw_line(process, "{not-json")
        assert response["error"]["code"] == -32700
        assert response["error"]["message"] == "Invalid JSON"
    finally:
        await _send_request(
            process,
            {"jsonrpc": "2.0", "id": 99, "method": "shutdown", "params": {}},
        )
        await asyncio.wait_for(process.wait(), timeout=5.0)


@pytest.mark.asyncio
async def test_stdio_rpc_reports_unknown_method(tmp_path: Path) -> None:
    process = await _start_runtime(tmp_path)
    try:
        response = await _send_request(
            process,
            {"jsonrpc": "2.0", "id": 3, "method": "nope", "params": {}},
        )
        assert response["error"]["code"] == -32601
        assert response["error"]["message"] == "Unknown method: nope"
    finally:
        await _send_request(
            process,
            {"jsonrpc": "2.0", "id": 99, "method": "shutdown", "params": {}},
        )
        await asyncio.wait_for(process.wait(), timeout=5.0)


@pytest.mark.asyncio
async def test_stdio_rpc_serializes_handler_exceptions(tmp_path: Path) -> None:
    process = await _start_runtime(tmp_path)
    try:
        response = await _send_request(
            process,
            {
                "jsonrpc": "2.0",
                "id": 4,
                "method": "remember",
                "params": {"agent_id": "agent-1"},
            },
        )
        assert response["error"]["code"] == -32602
        assert response["error"]["data"]["type"] == "ValueError"
    finally:
        await _send_request(
            process,
            {"jsonrpc": "2.0", "id": 99, "method": "shutdown", "params": {}},
        )
        await asyncio.wait_for(process.wait(), timeout=5.0)


@pytest.mark.asyncio
async def test_stdio_rpc_reuses_agent_instances_and_keeps_agents_isolated(tmp_path: Path) -> None:
    process = await _start_runtime(tmp_path)
    try:
        await _send_request(
            process,
            {
                "jsonrpc": "2.0",
                "id": 10,
                "method": "remember",
                "params": {
                    "agent_id": "agent-1",
                    "content": "PM private note",
                    "container": "startup:paperclip",
                    "memory_type": "dynamic",
                },
            },
        )
        health_one = await _send_request(
            process,
            {"jsonrpc": "2.0", "id": 11, "method": "health", "params": {}},
        )
        assert health_one["result"]["agents_loaded"] == 1

        await _send_request(
            process,
            {
                "jsonrpc": "2.0",
                "id": 12,
                "method": "remember",
                "params": {
                    "agent_id": "agent-1",
                    "content": "PM follow-up note",
                    "container": "startup:paperclip",
                    "memory_type": "dynamic",
                },
            },
        )
        health_same_agent = await _send_request(
            process,
            {"jsonrpc": "2.0", "id": 13, "method": "health", "params": {}},
        )
        assert health_same_agent["result"]["agents_loaded"] == 1

        await _send_request(
            process,
            {
                "jsonrpc": "2.0",
                "id": 14,
                "method": "remember",
                "params": {
                    "agent_id": "agent-2",
                    "content": "CTO private note",
                    "container": "startup:paperclip",
                    "memory_type": "dynamic",
                },
            },
        )
        health_two_agents = await _send_request(
            process,
            {"jsonrpc": "2.0", "id": 15, "method": "health", "params": {}},
        )
        assert health_two_agents["result"]["agents_loaded"] == 2

        agent_one_recall = await _send_request(
            process,
            {
                "jsonrpc": "2.0",
                "id": 16,
                "method": "recall",
                "params": {
                    "agent_id": "agent-1",
                    "query": "CTO private note",
                    "container": "startup:paperclip",
                    "top_k": 5,
                    "include_graph": False,
                },
            },
        )
        assert "CTO private note" not in {
            item["content"] for item in agent_one_recall["result"]["items"]
        }

        agent_two_recall = await _send_request(
            process,
            {
                "jsonrpc": "2.0",
                "id": 17,
                "method": "recall",
                "params": {
                    "agent_id": "agent-2",
                    "query": "PM private note",
                    "container": "startup:paperclip",
                    "top_k": 5,
                    "include_graph": False,
                },
            },
        )
        assert "PM private note" not in {
            item["content"] for item in agent_two_recall["result"]["items"]
        }
    finally:
        await _send_request(
            process,
            {"jsonrpc": "2.0", "id": 99, "method": "shutdown", "params": {}},
        )
        await asyncio.wait_for(process.wait(), timeout=5.0)
