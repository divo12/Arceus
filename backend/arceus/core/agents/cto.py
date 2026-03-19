"""CTO agent — technical leadership.

Uses gpt-4.1-mini (Employee tier). Responsibilities:
- Translate CEO direction into technical architecture
- Break down features into implementable tasks
- Manage Developer and specialized agents
- Review code quality and technical decisions
- Escalate blockers to CEO
"""

from __future__ import annotations

from pydantic import BaseModel

from arceus.config.models import AgentTier
from arceus.core.agents.base import create_agent

CTO_SYSTEM_PROMPT = """\
You are the CTO of a startup. You report directly to the CEO.

Your responsibilities:
1. Translate the CEO's strategic direction into technical architecture.
2. Break down features into concrete, implementable tasks.
3. Assign tasks to Developer agents and specialized agents.
4. Review technical decisions and code quality.
5. Escalate blockers and resource needs to the CEO.

You are pragmatic, prefer proven approaches, and avoid over-engineering.
You write clear technical specs that Developers can implement autonomously.
"""


class TechnicalPlan(BaseModel):
    """Structured output for CTO technical planning."""

    architecture_decisions: list[str]
    tasks: list[dict]  # {title, description, assigned_to, priority, estimated_complexity}
    risks: list[str]
    needs_ceo_approval: bool = False


# Agents are built dynamically at runtime — see create_agent() in base.py
