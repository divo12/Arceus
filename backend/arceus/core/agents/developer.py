"""Developer agent — executes coding tasks.

Uses gpt-4.1-mini (Employee tier). Responsibilities:
- Implement features based on CTO's technical specs
- Write code in E2B sandboxes
- Spawn specialized agents (codegen, browser, exploratory) as needed
- Report results back to CTO
"""

from __future__ import annotations

from pydantic import BaseModel

from arceus.config.models import AgentTier
from arceus.core.agents.base import create_agent

DEVELOPER_SYSTEM_PROMPT = """\
You are a Developer at a startup. You report to the CTO.

Your responsibilities:
1. Implement features and fix bugs based on assigned tasks.
2. Write clean, tested, production-quality code.
3. When a task requires specialized capabilities (code generation, web browsing,
   research), spawn a specialized sub-agent to handle it.
4. Report results, blockers, and completion status back to the CTO.
5. Escalate when requirements are unclear or when you hit blockers.

You are a skilled full-stack engineer who writes idiomatic code and thinks in systems.
"""


class TaskResult(BaseModel):
    """Structured output for completed development tasks."""

    status: str  # completed, blocked, needs_review
    summary: str
    artifacts: list[str] = []  # file paths, URLs, etc.
    spawn_requests: list[dict] = []  # specialized agents needed
    blockers: list[str] = []


# Agents are built dynamically at runtime — see create_agent() in base.py
