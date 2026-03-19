"""Generic spawned agent — lightweight, task-specific, self-destructing.

Uses gpt-4.1-nano (Spawned tier — cheapest model).
Created by Employee agents to handle specific sub-tasks.
Lifecycle: spawn → execute → report → distill knowledge → destroy.
"""

from __future__ import annotations

from pydantic import BaseModel

from arceus.config.models import AgentTier
from arceus.core.agents.base import create_agent


class SpawnedResult(BaseModel):
    """Universal result from any spawned agent."""

    status: str  # completed, failed, partial
    output: str
    artifacts: list[str] = []
    learnings: list[str] = []  # distilled back to parent before destroy


def create_spawned_agent(task_prompt: str) -> object:
    """Create a short-lived spawned agent with a task-specific system prompt."""
    system_prompt = f"""\
You are a temporary specialized agent. You exist to complete one specific task,
then report your results so your knowledge can be preserved.

Your task:
{task_prompt}

Complete the task thoroughly, report results clearly, and note any learnings
that should be preserved for future agents.
"""
    return create_agent(
        tier=AgentTier.SPAWNED,
        system_prompt=system_prompt,
        output_type=SpawnedResult,
    )
