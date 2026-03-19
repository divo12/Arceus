"""Spawn lifecycle flow — PydanticAI Graph.

Manages the full lifecycle of a spawned agent:
Create → Configure → Execute → Verify → Distill → Destroy.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from pydantic_ai_graph import Graph, GraphRunContext, End


@dataclass
class SpawnLifecycleState:
    parent_agent_id: str
    task_id: str
    spawn_type: str  # coding, browser, exploratory
    spawn_agent_id: str | None = None
    result: dict | None = None
    learnings: list[str] | None = None


@dataclass
class CreateSpawn:
    """Create the spawned agent DB record and configure it."""

    async def run(self, ctx: GraphRunContext[SpawnLifecycleState]) -> Any:
        # TODO: create Agent row with type=SPAWNED, spawned_by, spawned_for_task
        return ExecuteSpawn()


@dataclass
class ExecuteSpawn:
    """Run the spawned agent on its task."""

    async def run(self, ctx: GraphRunContext[SpawnLifecycleState]) -> Any:
        # TODO: run the appropriate spawned agent (coding/browser/exploratory)
        return VerifyResult()


@dataclass
class VerifyResult:
    """Verify the spawned agent's output meets requirements."""

    async def run(self, ctx: GraphRunContext[SpawnLifecycleState]) -> Any:
        # TODO: parent agent verifies the result
        return DistillKnowledge()


@dataclass
class DistillKnowledge:
    """Extract learnings before destroying the spawn."""

    async def run(self, ctx: GraphRunContext[SpawnLifecycleState]) -> Any:
        # TODO: store learnings in Mem0 via MemoryService
        return DestroySpawn()


@dataclass
class DestroySpawn:
    """Clean up the spawned agent."""

    async def run(self, ctx: GraphRunContext[SpawnLifecycleState]) -> Any:
        # TODO: mark agent as TERMINATED, clean up resources
        return End("spawn_complete")


spawn_lifecycle_graph = Graph(
    nodes=[CreateSpawn, ExecuteSpawn, VerifyResult, DistillKnowledge, DestroySpawn],
    state_type=SpawnLifecycleState,
)
