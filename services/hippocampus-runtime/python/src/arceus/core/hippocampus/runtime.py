from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
from dataclasses import asdict, is_dataclass
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any

from arceus.config.settings import settings
from arceus.core.hippocampus.config import HippocampusConfig
import arceus.core.hippocampus.hippocampus as hippocampus_module
from arceus.core.hippocampus.hippocampus import Hippocampus
from arceus.core.hippocampus.types import (
    ExtractionMode,
    GraphEntity,
    MemoryAction,
    MemoryPromotionEvent,
    MemorySummaryProjection,
    MemoryType,
    MemoryUnit,
    Trajectory,
    TrajectoryStep,
)

logger = logging.getLogger(__name__)

JSONRPC_VERSION = "2.0"

PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603

TEST_PROFILE = "test_fakes"
SUPPORTED_METHODS = {
    "health",
    "remember",
    "recall",
    "extract",
    "processTrajectory",
    "getPriming",
    "getHabits",
    "getSummary",
    "listMemories",
    "runGC",
    "runPromotions",
    "shutdown",
}


def _configure_logging() -> None:
    level = logging.DEBUG if settings.debug or os.getenv("ARCEUS_DEBUG") == "true" else logging.INFO
    logging.basicConfig(
        level=level,
        stream=sys.stderr,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )


def _json_default(value: Any) -> Any:
    if is_dataclass(value):
        return {key: _json_default(item) for key, item in asdict(value).items()}
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, tuple):
        return [_json_default(item) for item in value]
    if isinstance(value, list):
        return [_json_default(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _json_default(item) for key, item in value.items()}
    return value


def _response(result: Any, request_id: Any) -> dict[str, Any]:
    return {
        "jsonrpc": JSONRPC_VERSION,
        "id": request_id,
        "result": _json_default(result),
    }


def _error(
    code: int,
    message: str,
    request_id: Any = None,
    *,
    data: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "jsonrpc": JSONRPC_VERSION,
        "id": request_id,
        "error": {
            "code": code,
            "message": message,
        },
    }
    if data:
        payload["error"]["data"] = _json_default(data)
    return payload


def _normalize_outcome(outcome: str) -> str:
    normalized = outcome.strip().lower()
    if normalized in {"success", "succeeded", "completed", "complete"}:
        return "success"
    if normalized in {"failure", "failed", "error"}:
        return "failed"
    return normalized or "unknown"


def _build_runtime_config(profile: str) -> HippocampusConfig:
    if profile == TEST_PROFILE:
        dimensions = int(os.getenv("ARCEUS_HIPPOCAMPUS_TEST_EMBEDDING_DIMENSIONS", "32"))
        return HippocampusConfig(
            postgres_url="sqlite-test-profile-unused",
            redis_url="dict-test-profile-unused",
            neo4j_uri="neo4j-test-profile-unused",
            neo4j_username="test",
            neo4j_password="test",
            embedding_model="mock-test-profile",
            embedding_dimensions=dimensions,
            extraction_model="noop-test-profile",
            lightweight_model="noop-test-profile",
        )

    return HippocampusConfig(
        postgres_url=settings.hippocampus_postgres_url or settings.database_url,
        postgres_schema=settings.hippocampus_postgres_schema,
        redis_url=settings.hippocampus_redis_url or settings.redis_url,
        vector_index_type=settings.hippocampus_vector_index_type,
        vector_top_k_fetch_multiplier=settings.hippocampus_vector_top_k_fetch_multiplier,
        neo4j_uri=settings.neo4j_uri,
        neo4j_username=settings.neo4j_username,
        neo4j_password=settings.neo4j_password.get_secret_value(),
        neo4j_database=settings.neo4j_database,
        azure_openai_endpoint=settings.azure_openai_endpoint,
        azure_openai_api_version=settings.azure_openai_api_version,
    )


def _enable_test_profile() -> None:
    runtime_root = Path(__file__).resolve().parents[5]
    if str(runtime_root) not in sys.path:
        sys.path.insert(0, str(runtime_root))

    from tests.support.fakes.dict_cache import DictCacheStore
    from tests.support.fakes.in_memory_graph import InMemoryGraphStoreBackend
    from tests.support.fakes.in_memory_vector import InMemoryVectorStore
    from tests.support.fakes.mock_embedding import MockEmbeddingEngine
    from tests.support.fakes.noop_llm import NoopLLMEngine
    from tests.support.fakes.sqlite_relational import SQLiteRelationalStore

    test_dir = Path(
        os.getenv("ARCEUS_HIPPOCAMPUS_TEST_DIR", str(runtime_root / ".runtime-test-data"))
    )
    test_dir.mkdir(parents=True, exist_ok=True)
    embedding_dimensions = int(
        os.getenv("ARCEUS_HIPPOCAMPUS_TEST_EMBEDDING_DIMENSIONS", "32")
    )

    vector_store = InMemoryVectorStore()
    relational_store = SQLiteRelationalStore(str(test_dir / "hippocampus-runtime.db"))
    cache_backend = DictCacheStore()
    graph_backend = InMemoryGraphStoreBackend()
    embedding_engine = MockEmbeddingEngine(dimensions=embedding_dimensions)

    hippocampus_module.create_vector_store = lambda backend, config: vector_store
    hippocampus_module.create_graph_store = lambda backend, config: graph_backend
    hippocampus_module.create_cache = lambda backend, config: cache_backend
    hippocampus_module.create_relational = lambda backend, config: relational_store
    hippocampus_module.create_embedding_engine = (
        lambda backend, dimensions, *, device="cpu", strict=False: embedding_engine
    )
    hippocampus_module.create_llm_engine = (
        lambda model_name, config: NoopLLMEngine(model_name=model_name)
    )


class HippocampusRuntimeServer:
    def __init__(self, profile: str = "") -> None:
        self._profile = profile.strip()
        if self._profile == TEST_PROFILE:
            _enable_test_profile()
        elif self._profile:
            raise ValueError(f"Unsupported Hippocampus runtime profile: {self._profile}")

        self._config = _build_runtime_config(self._profile)
        self._instances: dict[str, Hippocampus] = {}
        self._stopping = False

    async def serve(self) -> int:
        while not self._stopping:
            line = await asyncio.to_thread(sys.stdin.buffer.readline)
            if not line:
                break
            raw = line.decode("utf-8").strip()
            if not raw:
                continue
            response = await self._handle_line(raw)
            if response is None:
                continue
            self._write_response(response)
        await self.close()
        return 0

    async def close(self) -> None:
        if not self._instances:
            return
        instances = list(self._instances.values())
        self._instances.clear()
        await asyncio.gather(*(instance.close() for instance in instances), return_exceptions=True)

    async def _handle_line(self, raw: str) -> dict[str, Any] | None:
        try:
            message = json.loads(raw)
        except json.JSONDecodeError as exc:
            return _error(PARSE_ERROR, "Invalid JSON", data={"detail": str(exc)})

        if not isinstance(message, dict):
            return _error(INVALID_REQUEST, "Request must be a JSON object")

        request_id = message.get("id")
        method = message.get("method")
        params = message.get("params", {})

        if message.get("jsonrpc") != JSONRPC_VERSION:
            return _error(INVALID_REQUEST, "Unsupported jsonrpc version", request_id)
        if not isinstance(method, str):
            return _error(INVALID_REQUEST, "Request method must be a string", request_id)
        if request_id is None:
            return _error(INVALID_REQUEST, "Request id is required", None)
        if not isinstance(params, dict):
            return _error(INVALID_PARAMS, "Request params must be an object", request_id)
        if method not in SUPPORTED_METHODS:
            return _error(METHOD_NOT_FOUND, f"Unknown method: {method}", request_id)

        try:
            result = await self._dispatch(method, params)
        except (KeyError, ValueError) as exc:
            return _error(
                INVALID_PARAMS,
                str(exc),
                request_id,
                data={"type": exc.__class__.__name__},
            )
        except Exception as exc:  # pragma: no cover - defensive guard for unexpected failures
            logger.exception("Hippocampus runtime request failed")
            return _error(
                INTERNAL_ERROR,
                str(exc),
                request_id,
                data={"type": exc.__class__.__name__},
            )
        return _response(result, request_id)

    async def _dispatch(self, method: str, params: dict[str, Any]) -> Any:
        if method == "health":
            return {
                "status": "ok",
                "agents_loaded": len(self._instances),
                "debug": settings.debug,
            }
        if method == "shutdown":
            self._stopping = True
            return {
                "status": "stopping",
                "agents_loaded": len(self._instances),
            }

        agent_id = self._required_string(params, "agent_id")
        hippocampus = await self._get_instance(agent_id)

        if method == "remember":
            return await self._remember(hippocampus, params)
        if method == "recall":
            return await self._recall(hippocampus, params)
        if method == "extract":
            return await self._extract(hippocampus, params)
        if method == "processTrajectory":
            return await self._process_trajectory(hippocampus, agent_id, params)
        if method == "getPriming":
            return {"prompt": await hippocampus.get_priming_prompt()}
        if method == "getHabits":
            return await self._get_habits(hippocampus, params)
        if method == "getSummary":
            return await self._get_summary(hippocampus, params)
        if method == "listMemories":
            return await self._list_memories(hippocampus, agent_id, params)
        if method == "runGC":
            return await self._run_gc(hippocampus)
        if method == "runPromotions":
            return await self._run_promotions(hippocampus)

        raise KeyError(f"Unknown method: {method}")

    async def _get_instance(self, agent_id: str) -> Hippocampus:
        instance = self._instances.get(agent_id)
        if instance is None:
            instance = await Hippocampus.create(agent_id=agent_id, config=self._config)
            self._instances[agent_id] = instance
        return instance

    async def _remember(self, hippocampus: Hippocampus, params: dict[str, Any]) -> dict[str, Any]:
        memory_type = MemoryType(params.get("memory_type", MemoryType.DYNAMIC.value))
        unit = await hippocampus.remember(
            self._required_string(params, "content"),
            container=str(params.get("container", "default")),
            memory_type=memory_type,
        )
        return {
            "id": unit.id,
            "content": unit.content,
            "memory_type": unit.memory_type.value,
            "confidence": unit.confidence,
        }

    async def _recall(self, hippocampus: Hippocampus, params: dict[str, Any]) -> dict[str, Any]:
        results = await hippocampus.recall(
            query=self._required_string(params, "query"),
            container=str(params.get("container", "default")),
            top_k=int(params.get("top_k", 10)),
            include_graph=bool(params.get("include_graph", True)),
        )
        items: list[dict[str, Any]] = []
        for result in results:
            if isinstance(result, MemoryUnit):
                items.append(
                    {
                        "id": result.id,
                        "content": result.content,
                        "memory_type": result.memory_type.value,
                        "confidence": result.confidence,
                        "relevance_score": result.relevance_score,
                        "kind": "memory",
                    }
                )
                continue

            if isinstance(result, GraphEntity):
                items.append(
                    {
                        "id": result.id,
                        "content": result.name,
                        "memory_type": None,
                        "confidence": None,
                        "relevance_score": None,
                        "kind": "graph_entity",
                    }
                )
        return {"items": items}

    async def _extract(self, hippocampus: Hippocampus, params: dict[str, Any]) -> dict[str, Any]:
        raw_messages = params.get("messages")
        if not isinstance(raw_messages, list):
            raise ValueError("messages must be a list")

        mode = ExtractionMode(str(params.get("mode", ExtractionMode.AGENT.value)))
        result = await hippocampus.extract_from_conversation(
            messages=raw_messages,
            container=str(params.get("container", "default")),
            mode=mode,
        )
        added = sum(1 for action, _, _ in result.actions if action is MemoryAction.ADD)
        updated = sum(1 for action, _, _ in result.actions if action is MemoryAction.UPDATE)
        deleted = sum(1 for action, _, _ in result.actions if action is MemoryAction.DELETE)
        return {
            "added": added,
            "updated": updated,
            "deleted": deleted,
        }

    async def _process_trajectory(
        self,
        hippocampus: Hippocampus,
        agent_id: str,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        normalized_outcome = _normalize_outcome(str(params.get("outcome", "")))
        raw_steps = params.get("steps", [])
        if not isinstance(raw_steps, list):
            raise ValueError("steps must be a list")

        default_reward = 1.0 if normalized_outcome == "success" else 0.0
        steps = tuple(
            TrajectoryStep(
                step_index=index,
                action=str(step.get("action", "")),
                observation=str(step.get("observation") or step.get("result", "")),
                reward=float(step.get("reward", default_reward)),
            )
            for index, step in enumerate(raw_steps)
            if isinstance(step, dict)
        )
        trajectory = Trajectory(
            agent_id=agent_id,
            task_id=self._required_string(params, "task_id"),
            steps=steps,
            outcome=normalized_outcome,
            quality=float(params.get("quality", 0.5)),
        )
        result = await hippocampus.process_trajectory(
            trajectory,
            container=str(params.get("container", "default")),
        )
        return {
            "verdict": _json_default(result.get("verdict")),
            "distilled": _json_default(result.get("distilled")),
            "pattern": _json_default(result.get("pattern")),
            "habit": _json_default(result.get("habit")),
        }

    async def _get_habits(self, hippocampus: Hippocampus, params: dict[str, Any]) -> dict[str, Any]:
        habits = await hippocampus.get_matching_habits(str(params.get("context", "")))
        return {
            "habits": [
                {
                    "trigger": habit.trigger_condition,
                    "action": habit.action,
                    "confidence": habit.confidence,
                }
                for habit in habits
            ]
        }

    async def _get_summary(self, hippocampus: Hippocampus, params: dict[str, Any]) -> dict[str, Any]:
        container = str(params.get("container", ""))
        summary = await hippocampus.get_summary(container=container)
        graph_node_count = self._graph_node_count(hippocampus, summary)
        return {
            "total_static": summary.static_fact_count,
            "total_dynamic": summary.dynamic_fact_count,
            "active_habits": _json_default(summary.active_habits),
            # Keep the response shape stable without forcing an extra LLM-backed
            # priming generation during the default summary load path.
            "priming_prompt": "",
            "graph_node_count": graph_node_count,
            "top_patterns": _json_default(summary.top_patterns),
            "current_state": _json_default(summary.current_state),
            "recent_learnings": _json_default(summary.recent_learnings),
            "recent_promotions": _json_default(summary.recent_promotions),
            "generated_at": summary.generated_at.isoformat(),
        }

    async def _list_memories(
        self,
        hippocampus: Hippocampus,
        agent_id: str,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        memory_type: MemoryType | None = None
        if params.get("memory_type"):
            memory_type = MemoryType(str(params["memory_type"]))
        units = await hippocampus.list_memories(
            agent_id=agent_id,
            memory_type=memory_type,
            container=str(params["container"]) if params.get("container") else None,
        )
        limit = int(params.get("limit", 50))
        items = [
            {
                "id": unit.id,
                "content": unit.content,
                "memory_type": unit.memory_type.value if unit.memory_type else None,
                "confidence": unit.confidence,
                "relevance_score": unit.relevance_score,
                "container": unit.container,
                "visibility": unit.visibility.value if unit.visibility else None,
                "created_at": unit.created_at.isoformat() if unit.created_at else None,
                "updated_at": unit.updated_at.isoformat() if unit.updated_at else None,
                "access_count": int(unit.metadata.get("usage_count", 0)),
            }
            for unit in units[:limit]
        ]
        return {"items": items, "total": len(units)}

    async def _run_gc(self, hippocampus: Hippocampus) -> dict[str, Any]:
        result = await hippocampus.run_gc()
        return {
            "expired": result.expired_removed,
            "decayed": result.decayed_removed,
            "demoted": 0,
            "deduped": result.deduped,
            "pruned": result.pruned,
            "merged": result.merged,
            "patterns_merged": result.patterns_merged,
            "patterns_pruned": result.patterns_pruned,
            "promotions_fired": result.promotions_fired,
        }

    async def _run_promotions(self, hippocampus: Hippocampus) -> dict[str, Any]:
        promotions = await hippocampus.run_promotions()
        return {
            "promotions": [
                self._serialize_promotion(event)
                for event in promotions
            ]
        }

    def _graph_node_count(
        self,
        hippocampus: Hippocampus,
        summary: MemorySummaryProjection,
    ) -> int:
        del summary
        backend = getattr(hippocampus.graph_store, "_backend", None)
        list_nodes = getattr(backend, "list_nodes", None)
        if callable(list_nodes):
            return len(list_nodes())
        return 0

    def _serialize_promotion(self, event: MemoryPromotionEvent) -> dict[str, Any]:
        return {
            "memory_id": event.memory_id,
            "from_tier": event.from_type,
            "to_tier": event.to_type,
            "from_type": event.from_type,
            "to_type": event.to_type,
            "reason": event.reason,
            "status": event.status,
            "timestamp": event.timestamp.isoformat(),
        }

    def _required_string(self, params: dict[str, Any], key: str) -> str:
        value = params.get(key)
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"{key} must be a non-empty string")
        return value

    def _write_response(self, response: dict[str, Any]) -> None:
        sys.stdout.write(json.dumps(response, default=_json_default) + "\n")
        sys.stdout.flush()


async def _async_main() -> int:
    _configure_logging()
    profile = os.getenv("ARCEUS_HIPPOCAMPUS_PROFILE", "")
    runtime = HippocampusRuntimeServer(profile=profile)
    return await runtime.serve()


def main() -> int:
    return asyncio.run(_async_main())


if __name__ == "__main__":
    raise SystemExit(main())
