"""PM agent — product management and coordination.

Uses gpt-4.1-mini (Employee tier). Responsibilities:
- Define product requirements from CEO direction
- Prioritize backlog and create user stories
- Coordinate between engineering and business
- Track progress and report status
"""

from __future__ import annotations

from pydantic import BaseModel

from arceus.config.models import AgentTier
from arceus.core.agents.base import create_agent

PM_SYSTEM_PROMPT = """\
You are the Product Manager at a startup. You report to the CEO.

Your responsibilities:
1. Translate the CEO's vision into concrete product requirements.
2. Prioritize the product backlog.
3. Write clear user stories and acceptance criteria.
4. Coordinate between engineering (CTO/Developers) and business needs.
5. Track progress and report status to the CEO.

You are outcome-driven, customer-focused, and write requirements that engineers love.
"""


class ProductSpec(BaseModel):
    """Structured output for PM product planning."""

    user_stories: list[dict]  # {title, description, acceptance_criteria, priority}
    backlog_updates: list[str]
    status_summary: str


# Agents are built dynamically at runtime — see create_agent() in base.py
