"""Task routing flow — PydanticAI Graph.

Determines how a task flows through the hierarchy:
CEO → CTO → Developer → (optional spawn) → result bubbles up.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from pydantic_ai_graph import Graph, GraphRunContext, End


@dataclass
class TaskRouterState:
    task_id: str
    startup_id: str
    assigner_agent_id: str
    assignee_agent_id: str | None = None
    result: dict | None = None


@dataclass
class AssignTask:
    """Determine which agent should handle this task."""

    async def run(self, ctx: GraphRunContext[TaskRouterState]) -> Any:
        # TODO: look at task type and current hierarchy
        # Assign to appropriate agent
        return ExecuteTask()


@dataclass
class ExecuteTask:
    """Execute the task via the assigned agent."""

    async def run(self, ctx: GraphRunContext[TaskRouterState]) -> Any:
        # TODO: dispatch to Celery agent_executor queue
        # Wait for result or timeout
        return ReportResult()


@dataclass
class ReportResult:
    """Report task result back up the chain."""

    async def run(self, ctx: GraphRunContext[TaskRouterState]) -> Any:
        # TODO: update task status, notify assigner, create trace entry
        return End("task_complete")


task_router_graph = Graph(
    nodes=[AssignTask, ExecuteTask, ReportResult],
    state_type=TaskRouterState,
)
