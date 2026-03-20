"""HierarchyService — LLM-powered org chart proposal and instantiation."""

from __future__ import annotations

import json
import logging
from typing import Any

from pydantic import BaseModel
from pydantic_ai import Agent
from pydantic_ai.models.openai import OpenAIModel
from pydantic_ai.providers.openai import OpenAIProvider
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from arceus.config.settings import settings
from arceus.core.roles import ROLE_CATALOG, SUPPORTED_ROLES, roles_summary_for_prompt
from arceus.db.models.agent import Agent as AgentModel, AgentType, AgentStatus
from arceus.db.models.memory import ChatMessage
from arceus.db.models.startup import Startup

logger = logging.getLogger(__name__)


class HierarchyNode(BaseModel):
    role: str
    title: str
    level: int
    reports_to: str | None = None
    responsibilities: str


class HierarchyProposalResult(BaseModel):
    roles: list[HierarchyNode]
    reasoning: str
    estimated_monthly_cost: float


def _build_hierarchy_agent() -> Agent:
    """Build a PydanticAI agent for hierarchy proposal."""
    roles_info = roles_summary_for_prompt()
    supported_list = ", ".join(SUPPORTED_ROLES)
    system_prompt = f"""\
You are an expert organizational designer for AI-powered startups.
Given a startup idea and budget, propose the optimal team structure.

{roles_info}

CRITICAL RULES:
- The CEO already exists (level 0). Do NOT include CEO in your proposal.
- ONLY use roles from this list: {supported_list}
- Every role needs a clear "reports_to" — use the role name of their manager
- Level 1 roles report to "CEO", level 2 roles report to a level 1 role
- Be practical — match team size to budget
- Choose roles that specifically match the startup idea

Respond with ONLY valid JSON matching this exact schema:
{{
  "roles": [
    {{"role": "CTO", "title": "Chief Technology Officer", "level": 1, "reports_to": "CEO", "responsibilities": "..."}},
    {{"role": "Full-stack Developer", "title": "Full-stack Developer", "level": 2, "reports_to": "CTO", "responsibilities": "..."}}
  ],
  "reasoning": "Why this structure fits the idea and budget",
  "estimated_monthly_cost": 150.00
}}
"""
    if settings.azure_openai_endpoint and settings.azure_openai_api_key.get_secret_value():
        from openai import AsyncAzureOpenAI

        client = AsyncAzureOpenAI(
            azure_endpoint=settings.azure_openai_endpoint,
            api_key=settings.azure_openai_api_key.get_secret_value(),
            api_version=settings.azure_openai_api_version,
        )
        provider = OpenAIProvider(openai_client=client)
        model = OpenAIModel(settings.model_ceo, provider=provider)
    else:
        model = OpenAIModel(settings.model_ceo)

    return Agent(model=model, system_prompt=system_prompt)


class HierarchyService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def propose(self, startup_id: str) -> dict:
        """Use LLM to propose an org chart from the startup idea and budget."""
        startup = await self.session.get(Startup, startup_id)
        if not startup:
            return {"error": "Startup not found"}

        agent = _build_hierarchy_agent()
        prompt = (
            f"Startup: {startup.name}\n"
            f"Idea: {startup.core_idea}\n"
            f"Current direction: {startup.current_direction}\n"
            f"Total budget: ${float(startup.budget_allocated):.2f}\n\n"
            f"Propose the optimal team hierarchy."
        )

        result = await agent.run(prompt)
        raw = result.output

        # Parse the JSON from the LLM response
        try:
            # Try to extract JSON from the response
            text = raw if isinstance(raw, str) else str(raw)
            # Find JSON in the response
            start = text.find("{")
            end = text.rfind("}") + 1
            if start >= 0 and end > start:
                proposal = json.loads(text[start:end])
            else:
                proposal = json.loads(text)
        except (json.JSONDecodeError, ValueError) as e:
            logger.error("Failed to parse hierarchy proposal: %s\nRaw: %s", e, raw)
            # Fallback: minimal hierarchy
            proposal = {
                "roles": [
                    {
                        "role": "CTO",
                        "title": "Chief Technology Officer",
                        "level": 1,
                        "reports_to": "CEO",
                        "responsibilities": "Technical architecture and engineering oversight",
                    },
                    {
                        "role": "Full-stack Developer",
                        "title": "Full-stack Developer",
                        "level": 2,
                        "reports_to": "CTO",
                        "responsibilities": "Build features end-to-end",
                    },
                ],
                "reasoning": "Minimal viable team for the given budget.",
                "estimated_monthly_cost": float(startup.budget_allocated) * 0.3,
            }

        proposal["startup_id"] = startup_id
        return proposal

    async def approve(self, startup_id: str, roles: list[dict]) -> list[dict]:
        """User approves the proposed hierarchy — instantiate all agents."""
        startup = await self.session.get(Startup, startup_id)
        if not startup:
            return []

        # Find CEO agent to use as parent reference
        result = await self.session.execute(
            select(AgentModel).where(
                AgentModel.startup_id == startup_id,
                AgentModel.role == "CEO",
            )
        )
        ceo = result.scalar_one_or_none()

        created_agents: list[dict] = []
        agent_by_role: dict[str, AgentModel] = {}
        if ceo:
            agent_by_role["CEO"] = ceo

        # Sort by level to ensure parents are created before children
        sorted_roles = sorted(roles, key=lambda r: r.get("level", 1))

        for role_def in sorted_roles:
            role_name = role_def["role"]
            template = ROLE_CATALOG.get(role_name)
            system_prompt = template.system_prompt if template else f"You are the {role_name}. {role_def.get('responsibilities', '')}"

            # Find parent agent
            reports_to = role_def.get("reports_to", "CEO")
            parent = agent_by_role.get(reports_to)

            agent = AgentModel(
                startup_id=startup_id,
                name=role_def.get("title", role_name),
                role=role_name,
                agent_type=AgentType.EMPLOYEE,
                status=AgentStatus.IDLE,
                level=role_def.get("level", 1),
                parent_agent_id=parent.id if parent else (ceo.id if ceo else None),
                system_prompt=system_prompt,
            )
            self.session.add(agent)
            await self.session.flush()

            agent_by_role[role_name] = agent
            created_agents.append({
                "id": agent.id,
                "role": role_name,
                "title": role_def.get("title", role_name),
                "level": role_def.get("level", 1),
                "reports_to": reports_to,
            })

        # Persist the "team assembled" message in chat history
        roles_summary = "\n".join(
            f"- **{a['title']}** → reports to {a['reports_to']}" for a in created_agents
        )
        msg = ChatMessage(
            startup_id=startup_id,
            role="assistant",
            content=(
                f"**Team assembled!** I've onboarded {len(created_agents)} new employees:\n\n"
                f"{roles_summary}\n\n"
                "Head to the **Employees** tab to see your team. "
                "When you're ready, hit **Start Company** and I'll begin delegating tasks."
            ),
        )
        self.session.add(msg)

        return created_agents

    async def get(self, startup_id: str) -> dict:
        """Get current hierarchy for a startup."""
        result = await self.session.execute(
            select(AgentModel)
            .where(AgentModel.startup_id == startup_id)
            .order_by(AgentModel.level)
        )
        agents = result.scalars().all()
        nodes = []
        for a in agents:
            nodes.append({
                "id": a.id,
                "role": a.role,
                "name": a.name,
                "level": a.level,
                "status": a.status,
                "parent_agent_id": a.parent_agent_id,
            })
        return {"startup_id": startup_id, "nodes": nodes}
