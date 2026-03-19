"""Startup initialization flow — PydanticAI Graph.

Triggered when a user creates a new startup.
Flow: FundamentalIdea → CEO interprets → proposes hierarchy → user approves → agents spawned.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from pydantic_ai_graph import Graph, GraphRunContext, End

# TODO: implement with actual PydanticAI Graph nodes


@dataclass
class StartupInitState:
    startup_id: str
    idea: str
    ceo_interpretation: str | None = None
    hierarchy_proposal: dict | None = None
    approved: bool = False


@dataclass
class InterpretIdea:
    """CEO interprets the founder's idea."""

    async def run(self, ctx: GraphRunContext[StartupInitState]) -> Any:
        # TODO: run ceo_agent with the idea
        # Store interpretation in state
        ctx.state.ceo_interpretation = "TODO: CEO interpretation"
        return ProposeHierarchy()


@dataclass
class ProposeHierarchy:
    """CEO proposes org structure."""

    async def run(self, ctx: GraphRunContext[StartupInitState]) -> Any:
        # TODO: run ceo_hierarchy_agent
        # Store proposal, create Approval for user review
        ctx.state.hierarchy_proposal = {}
        return WaitForApproval()


@dataclass
class WaitForApproval:
    """Wait for user to approve hierarchy."""

    async def run(self, ctx: GraphRunContext[StartupInitState]) -> Any:
        # This node is re-entered when the approval webhook fires
        if ctx.state.approved:
            return SpawnAgents()
        return End("awaiting_approval")


@dataclass
class SpawnAgents:
    """Instantiate all agents in the approved hierarchy."""

    async def run(self, ctx: GraphRunContext[StartupInitState]) -> Any:
        # TODO: iterate hierarchy nodes → create Agent rows → start agent loops
        return End("startup_initialized")


startup_init_graph = Graph(
    nodes=[InterpretIdea, ProposeHierarchy, WaitForApproval, SpawnAgents],
    state_type=StartupInitState,
)
