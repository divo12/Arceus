"""Escalation chain flow — PydanticAI Graph.

When an agent can't resolve an issue, it escalates up the hierarchy.
Chain: Spawned → Employee → CTO/PM → CEO → User (Approval).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from pydantic_ai_graph import Graph, GraphRunContext, End


@dataclass
class EscalationState:
    task_id: str
    startup_id: str
    source_agent_id: str
    current_level: int = 0
    issue: str = ""
    resolution: str | None = None
    reached_user: bool = False


@dataclass
class AttemptResolution:
    """Current-level agent attempts to resolve the issue."""

    async def run(self, ctx: GraphRunContext[EscalationState]) -> Any:
        # TODO: run the agent at current hierarchy level
        # If resolved, end. Otherwise, escalate.
        return CheckResolved()


@dataclass
class CheckResolved:
    """Check if the issue was resolved at this level."""

    async def run(self, ctx: GraphRunContext[EscalationState]) -> Any:
        if ctx.state.resolution:
            return End("resolved")
        return EscalateUp()


@dataclass
class EscalateUp:
    """Move the issue up one level in the hierarchy."""

    async def run(self, ctx: GraphRunContext[EscalationState]) -> Any:
        ctx.state.current_level += 1
        # TODO: find parent agent in hierarchy
        # If no parent (reached top), escalate to user
        if ctx.state.current_level > 3:  # rough limit
            return CreateApproval()
        return AttemptResolution()


@dataclass
class CreateApproval:
    """Issue reached the user — create an Approval for human review."""

    async def run(self, ctx: GraphRunContext[EscalationState]) -> Any:
        ctx.state.reached_user = True
        # TODO: create Approval row, send notification to user
        return End("awaiting_user")


escalation_chain_graph = Graph(
    nodes=[AttemptResolution, CheckResolved, EscalateUp, CreateApproval],
    state_type=EscalationState,
)
