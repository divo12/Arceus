"""Base agent factory — shared PydanticAI agent configuration."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from pydantic_ai import Agent

from arceus.config.models import AgentTier, TIER_MODEL_MAP
from arceus.config.settings import settings


@dataclass
class AgentDeps:
    """Shared dependency container injected into every PydanticAI agent run."""

    startup_id: str
    agent_db_id: str
    tier: AgentTier
    # Injected at runtime
    db_session: Any = None
    mem0_client: Any = None


def create_agent(
    tier: AgentTier,
    system_prompt: str,
    result_type: type | None = None,
    tools: list | None = None,
) -> Agent:
    """Factory: create a PydanticAI agent wired to the correct Azure OpenAI model."""
    model_name = TIER_MODEL_MAP[tier]
    # PydanticAI model string for Azure OpenAI:
    #   azure:<deployment-name>
    model = f"azure:{model_name}"

    kwargs: dict[str, Any] = {
        "model": model,
        "system_prompt": system_prompt,
        "deps_type": AgentDeps,
    }
    if result_type is not None:
        kwargs["result_type"] = result_type
    if tools:
        kwargs["tools"] = tools

    return Agent(**kwargs)
