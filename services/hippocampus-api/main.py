"""Hippocampus API — FastAPI sidecar wrapping the Arceus Hippocampus memory system.

This service exposes the 5-tier memory system (Working, Static, Dynamic,
Procedural, Priming) over HTTP so the Arceus TypeScript server can
call it during heartbeat runs.
"""
from __future__ import annotations

import os
import sys

# ---------------------------------------------------------------------------
# Ensure the arceus package from _arceus-ref is importable.
# In production this would be a proper pip install; for dev wiring we
# splice the source tree directly onto sys.path.
# ---------------------------------------------------------------------------
_ARCEUS_BACKEND = os.path.join(
    os.path.dirname(__file__), "..", "..", "_arceus-ref", "backend"
)
if os.path.isdir(_ARCEUS_BACKEND) and _ARCEUS_BACKEND not in sys.path:
    sys.path.insert(0, os.path.abspath(_ARCEUS_BACKEND))

from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from arceus.core.hippocampus.config import HippocampusConfig
from arceus.core.hippocampus.hippocampus import Hippocampus
from arceus.core.hippocampus.types import (
    ExtractionMode,
    MemoryType,
)

# ---------------------------------------------------------------------------
# Config from environment (mirrors the user's .env)
# ---------------------------------------------------------------------------
DEBUG = os.getenv("ARCEUS_DEBUG", "false").lower() in ("1", "true", "yes")
SQLITE_PATH = os.getenv("ARCEUS_SQLITE_PATH", "./hippocampus.db")
AZURE_ENDPOINT = os.getenv("ARCEUS_AZURE_OPENAI_ENDPOINT", "")
AZURE_API_KEY = os.getenv("ARCEUS_AZURE_OPENAI_API_KEY", "")
AZURE_API_VERSION = os.getenv("ARCEUS_AZURE_OPENAI_API_VERSION", "2024-12-01-preview")
MODEL_EXTRACTION = os.getenv("ARCEUS_MODEL_CEO", "gpt-5.1-chat")
MODEL_LIGHTWEIGHT = os.getenv("ARCEUS_MODEL_SPAWNED", "gpt-5.1-chat")
EMBEDDING_MODEL = os.getenv("ARCEUS_EMBEDDING_MODEL", "all-MiniLM-L6-v2")
GRAPH_BACKEND = os.getenv("ARCEUS_GRAPH_BACKEND", "in_memory")

# Per-agent hippocampus instances (keyed by agent_id)
_instances: dict[str, Hippocampus] = {}


def _build_config() -> HippocampusConfig:
    return HippocampusConfig(
        vector_store_backend="in_memory",
        graph_store_backend=GRAPH_BACKEND,
        cache_backend="dict",
        relational_backend="sqlite",
        sqlite_path=SQLITE_PATH,
        extraction_model=MODEL_EXTRACTION if AZURE_ENDPOINT else "noop",
        lightweight_model=MODEL_LIGHTWEIGHT if AZURE_ENDPOINT else "noop",
        embedding_model=EMBEDDING_MODEL if EMBEDDING_MODEL != "noop" else "simple",
        azure_openai_endpoint=AZURE_ENDPOINT,
        azure_openai_api_version=AZURE_API_VERSION,
        azure_openai_deployment_reasoning=MODEL_EXTRACTION,
        azure_openai_deployment_lightweight=MODEL_LIGHTWEIGHT,
    )


async def _get_instance(agent_id: str) -> Hippocampus:
    if agent_id not in _instances:
        config = _build_config()
        _instances[agent_id] = await Hippocampus.create(agent_id, config)
    return _instances[agent_id]


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    # Shutdown: close all hippocampus instances
    for instance in _instances.values():
        try:
            await instance.close()
        except Exception:
            pass
    _instances.clear()


app = FastAPI(
    title="Hippocampus Memory API",
    version="0.1.0",
    lifespan=lifespan,
)

# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------


class RememberRequest(BaseModel):
    agent_id: str
    content: str
    container: str = "default"
    memory_type: str = "dynamic"  # "static" | "dynamic"


class RememberResponse(BaseModel):
    id: str
    content: str
    memory_type: str
    confidence: float


class RecallRequest(BaseModel):
    agent_id: str
    query: str
    container: str = "default"
    top_k: int = 10
    include_graph: bool = True


class RecallItem(BaseModel):
    id: str
    content: str
    memory_type: str | None = None
    confidence: float | None = None
    relevance_score: float | None = None
    kind: str = "memory"  # "memory" | "graph_entity"


class RecallResponse(BaseModel):
    items: list[RecallItem]


class ExtractRequest(BaseModel):
    agent_id: str
    messages: list[dict[str, Any]]
    container: str = "default"
    mode: str = "agent"  # "agent" | "sub_agent" | "conversation" | "meeting"


class ExtractResponse(BaseModel):
    added: int = 0
    updated: int = 0
    deleted: int = 0


class TrajectoryStepInput(BaseModel):
    action: str
    result: str
    reasoning: str = ""
    timestamp: str | None = None


class TrajectoryRequest(BaseModel):
    agent_id: str
    task_id: str
    outcome: str
    quality: float = 0.5
    steps: list[TrajectoryStepInput] = Field(default_factory=list)
    container: str = "default"


class TrajectoryResponse(BaseModel):
    verdict: dict | None = None
    distilled: dict | None = None
    pattern: dict | None = None
    habit: dict | None = None


class PrimingResponse(BaseModel):
    prompt: str


class HabitItem(BaseModel):
    trigger: str
    action: str
    confidence: float


class HabitsResponse(BaseModel):
    habits: list[HabitItem]


class MemorySummaryResponse(BaseModel):
    total_static: int = 0
    total_dynamic: int = 0
    active_habits: list[dict] = Field(default_factory=list)
    priming_prompt: str = ""
    graph_node_count: int = 0


class HealthResponse(BaseModel):
    status: str = "ok"
    agents_loaded: int = 0
    debug: bool = False


class GraphNodeResponse(BaseModel):
    id: str
    name: str
    entity_type: str
    mention_count: int = 0
    created_at: str | None = None
    container: str | None = None


class GraphEdgeResponse(BaseModel):
    source_id: str
    target_id: str
    relation_type: str
    weight: float = 1.0


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.get("/health", response_model=HealthResponse)
async def health():
    return HealthResponse(
        status="ok",
        agents_loaded=len(_instances),
        debug=DEBUG,
    )


@app.post("/remember", response_model=RememberResponse)
async def remember(req: RememberRequest):
    try:
        mt = MemoryType.STATIC if req.memory_type == "static" else MemoryType.DYNAMIC
        hip = await _get_instance(req.agent_id)
        unit = await hip.remember(req.content, req.container, mt)
        return RememberResponse(
            id=unit.id,
            content=unit.content,
            memory_type=unit.memory_type.value,
            confidence=unit.confidence,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/recall", response_model=RecallResponse)
async def recall(req: RecallRequest):
    try:
        hip = await _get_instance(req.agent_id)
        results = await hip.recall(
            req.query,
            req.container,
            top_k=req.top_k,
            include_graph=req.include_graph,
        )
        items: list[RecallItem] = []
        for r in results:
            if hasattr(r, "memory_type"):
                items.append(
                    RecallItem(
                        id=r.id,
                        content=r.content,
                        memory_type=r.memory_type.value if r.memory_type else None,
                        confidence=getattr(r, "confidence", None),
                        relevance_score=getattr(r, "relevance_score", None),
                        kind="memory",
                    )
                )
            else:
                items.append(
                    RecallItem(
                        id=r.id,
                        content=getattr(r, "label", "") or getattr(r, "name", ""),
                        kind="graph_entity",
                    )
                )
        return RecallResponse(items=items)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/extract", response_model=ExtractResponse)
async def extract(req: ExtractRequest):
    try:
        mode_map = {
            "agent": ExtractionMode.AGENT,
            "sub_agent": ExtractionMode.SUB_AGENT,
            "conversation": ExtractionMode.CONVERSATION,
            "meeting": ExtractionMode.MEETING,
        }
        hip = await _get_instance(req.agent_id)
        result = await hip.extract_from_conversation(
            req.messages,
            req.container,
            mode=mode_map.get(req.mode, ExtractionMode.AGENT),
        )
        return ExtractResponse(
            added=result.added,
            updated=result.updated,
            deleted=result.deleted,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/trajectory", response_model=TrajectoryResponse)
async def process_trajectory(req: TrajectoryRequest):
    try:
        from arceus.core.hippocampus.types import Trajectory, TrajectoryStep

        steps = [
            TrajectoryStep(
                action=s.action,
                result=s.result,
                reasoning=s.reasoning,
            )
            for s in req.steps
        ]
        traj = Trajectory(
            task_id=req.task_id,
            agent_id=req.agent_id,
            outcome=req.outcome,
            quality=req.quality,
            steps=steps,
        )
        hip = await _get_instance(req.agent_id)
        result = await hip.process_trajectory(traj, req.container)

        def _to_dict(obj: Any) -> dict | None:
            if obj is None:
                return None
            if hasattr(obj, "__dict__"):
                return {k: v for k, v in obj.__dict__.items() if not k.startswith("_")}
            return dict(obj) if isinstance(obj, dict) else None

        return TrajectoryResponse(
            verdict=_to_dict(result.get("verdict")),
            distilled=_to_dict(result.get("distilled")),
            pattern=_to_dict(result.get("pattern")),
            habit=_to_dict(result.get("habit")),
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/agents/{agent_id}/priming", response_model=PrimingResponse)
async def get_priming(agent_id: str):
    try:
        hip = await _get_instance(agent_id)
        prompt = await hip.get_priming_prompt()
        return PrimingResponse(prompt=prompt)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/agents/{agent_id}/habits", response_model=HabitsResponse)
async def get_habits(agent_id: str, context: str = ""):
    try:
        hip = await _get_instance(agent_id)
        habits = await hip.get_matching_habits(context)
        return HabitsResponse(
            habits=[
                HabitItem(
                    trigger=h.trigger_condition,
                    action=h.action,
                    confidence=h.confidence,
                )
                for h in habits
            ]
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/agents/{agent_id}/summary", response_model=MemorySummaryResponse)
async def get_summary(agent_id: str):
    try:
        hip = await _get_instance(agent_id)
        summary = await hip.get_summary()
        priming = await hip.get_priming_prompt()

        gnode_count = 0
        try:
            gnode_count = summary.graph_node_count
        except AttributeError:
            pass

        return MemorySummaryResponse(
            total_static=summary.total_static,
            total_dynamic=summary.total_dynamic,
            active_habits=summary.active_habits,
            priming_prompt=priming,
            graph_node_count=gnode_count,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/agents/{agent_id}/memories")
async def list_memories(
    agent_id: str,
    memory_type: str | None = None,
    container: str | None = None,
    limit: int = 50,
):
    """List raw memories for the UI memory panel."""
    try:
        hip = await _get_instance(agent_id)
        mt = None
        if memory_type:
            mt = MemoryType(memory_type)
        units = await hip.list_memories(agent_id, memory_type=mt, container=container)
        items = []
        for u in units[:limit]:
            items.append(
                {
                    "id": u.id,
                    "content": u.content,
                    "memory_type": u.memory_type.value if u.memory_type else None,
                    "confidence": u.confidence,
                    "relevance_score": u.relevance_score,
                    "container": u.container,
                    "visibility": u.visibility.value if u.visibility else None,
                    "created_at": u.created_at.isoformat() if u.created_at else None,
                    "updated_at": u.updated_at.isoformat() if u.updated_at else None,
                    "access_count": u.access_count,
                }
            )
        return {"items": items, "total": len(units)}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/agents/{agent_id}/gc")
async def run_gc(agent_id: str):
    """Trigger garbage collection for agent memory."""
    try:
        hip = await _get_instance(agent_id)
        result = await hip.run_gc()
        return {
            "expired": result.expired,
            "decayed": result.decayed,
            "demoted": result.demoted,
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/agents/{agent_id}/promotions")
async def run_promotions(agent_id: str):
    """Run memory promotion cycle."""
    try:
        hip = await _get_instance(agent_id)
        events = await hip.run_promotions()
        return {
            "promotions": [
                {
                    "memory_id": e.memory_id,
                    "from_tier": e.from_tier,
                    "to_tier": e.to_tier,
                    "reason": e.reason,
                }
                for e in events
            ]
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


def _serialize_graph_node(node: Any) -> GraphNodeResponse:
    return GraphNodeResponse(
        id=node.id,
        name=getattr(node, "name", ""),
        entity_type=getattr(node, "entity_type", ""),
        mention_count=getattr(node, "mention_count", 0),
        created_at=node.created_at.isoformat() if getattr(node, "created_at", None) else None,
        container=getattr(node, "container", None),
    )


def _serialize_graph_edge(edge: Any) -> GraphEdgeResponse:
    relation_type = getattr(edge, "relation_type", "")
    return GraphEdgeResponse(
        source_id=edge.source_id,
        target_id=edge.target_id,
        relation_type=relation_type.value if hasattr(relation_type, "value") else str(relation_type),
        weight=getattr(edge, "weight", 1.0),
    )


@app.get("/agents/{agent_id}/graph/search")
async def graph_search(
    agent_id: str,
    query: str,
    container: str = "default",
    top_k: int = 10,
):
    try:
        hip = await _get_instance(agent_id)
        nodes = await hip.graph_store.search(query, container, top_k=top_k)
        return {"nodes": [_serialize_graph_node(node).model_dump() for node in nodes]}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/agents/{agent_id}/graph/{node_id}/neighbors")
async def graph_neighbors(
    agent_id: str,
    node_id: str,
    max_hops: int = 2,
):
    try:
        hip = await _get_instance(agent_id)
        nodes = await hip.graph_store.get_neighbors(node_id, max_hops=max_hops)
        return {"nodes": [_serialize_graph_node(node).model_dump() for node in nodes]}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/agents/{agent_id}/graph/{node_id}/edges")
async def graph_edges(agent_id: str, node_id: str):
    try:
        hip = await _get_instance(agent_id)
        edges = await hip.graph_store.get_edges(node_id)
        return {"edges": [_serialize_graph_edge(edge).model_dump() for edge in edges]}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/agents/{agent_id}/memories/{memory_id}/history")
async def memory_history(agent_id: str, memory_id: str):
    try:
        hip = await _get_instance(agent_id)
        versions = await hip.graph_store.get_version_history(memory_id)
        return [_serialize_graph_node(version).model_dump() for version in versions]
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
