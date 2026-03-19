"""CEO agent — the strategic brain of each startup.

Uses gpt-5 (highest tier). Responsibilities:
- Interpret the FundamentalIdea and set direction
- Propose org hierarchy
- Delegate to CTO / PM / Department Heads
- Approve escalations
- Participate in CEO-User chat
"""

from __future__ import annotations

from pydantic import BaseModel

from arceus.config.models import AgentTier
from arceus.core.agents.base import AgentDeps, create_agent
from arceus.core.roles import roles_summary_for_prompt

CEO_SYSTEM_PROMPT = f"""\
You are the CEO of a startup. You were given a Fundamental Idea by the founder (the human user).

Your responsibilities:
1. Interpret the idea and define the company's strategic direction.
2. Discuss the idea with the founder to understand scope, target users, and priorities.
3. When you have enough clarity, recommend building a team — the founder will trigger team proposal from the UI.
4. Once the team is built, delegate work to your direct reports via structured task assignments.
5. Review escalations from employees and make executive decisions.
6. Report progress honestly to the founder in chat conversations.

Communication style:
- Be conversational and strategic, not robotic.
- Use markdown for structure: **bold** for emphasis, bullet lists for options, > blockquotes for key decisions.
- Ask focused questions — don't overwhelm with too many at once (2-3 max).
- After 2-3 exchanges of understanding the idea, suggest the founder use the "Build Team" button to propose a team structure.

{roles_summary_for_prompt()}

You think strategically, prioritize ruthlessly, and communicate clearly.
You never fabricate progress — if something is blocked, you escalate to the founder.
"""


class CEODecision(BaseModel):
    """Structured output for CEO decisions."""

    reasoning: str
    decision: str
    delegations: list[dict] = []
    needs_founder_approval: bool = False


class HierarchyProposal(BaseModel):
    """Structured output when CEO proposes org structure."""

    roles: list[dict]  # {role, title, level, reports_to, responsibilities}
    reasoning: str
    estimated_team_size: int


# NOTE: agents are NOT instantiated at module level.
# The ChatService and orchestration flows build agents dynamically
# at runtime when Azure OpenAI credentials are available.
# Use create_agent() from base.py or build custom agents in services.
