"""Meeting protocol flow — PydanticAI Graph.

Orchestrates standup and escalation meetings:
Set Agenda → Gather Responses → Synthesize Decisions → Record Learnings.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from pydantic_ai_graph import Graph, GraphRunContext, End


@dataclass
class MeetingProtocolState:
    meeting_id: str
    startup_id: str
    meeting_type: str  # standup, escalation, sync
    participant_ids: list[str] | None = None
    agenda: list[str] | None = None
    responses: list[dict] | None = None
    decisions: list[str] | None = None
    learnings: list[str] | None = None


@dataclass
class SetAgenda:
    """CEO or initiator sets the meeting agenda."""

    async def run(self, ctx: GraphRunContext[MeetingProtocolState]) -> Any:
        # TODO: generate agenda based on meeting type
        # Standup: each agent reports status
        # Escalation: specific issue to resolve
        return GatherResponses()


@dataclass
class GatherResponses:
    """Each participant provides their input."""

    async def run(self, ctx: GraphRunContext[MeetingProtocolState]) -> Any:
        # TODO: run each participant agent with the agenda
        # Collect responses in parallel
        return SynthesizeDecisions()


@dataclass
class SynthesizeDecisions:
    """CEO synthesizes responses into decisions."""

    async def run(self, ctx: GraphRunContext[MeetingProtocolState]) -> Any:
        # TODO: run CEO agent to make decisions from gathered responses
        return RecordLearnings()


@dataclass
class RecordLearnings:
    """Extract and store meeting learnings in memory."""

    async def run(self, ctx: GraphRunContext[MeetingProtocolState]) -> Any:
        # TODO: consolidate learnings via MemoryService
        return End("meeting_complete")


meeting_protocol_graph = Graph(
    nodes=[SetAgenda, GatherResponses, SynthesizeDecisions, RecordLearnings],
    state_type=MeetingProtocolState,
)
