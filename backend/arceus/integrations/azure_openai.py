"""Azure OpenAI client with model tiering and cost tracking."""

from arceus.config.settings import settings
from arceus.config.models import AgentTier, TIER_MODEL_MAP


def get_model_for_tier(tier: AgentTier) -> str:
    """Get the deployment name for a given agent tier."""
    return TIER_MODEL_MAP.get(tier, settings.model_employee)


# TODO: implement actual Azure OpenAI client
# - PydanticAI handles the LLM calls internally
# - This module provides model selection + cost recording hooks
# - Token counting and rate limiting
# - Structured outputs via PydanticAI's native support
