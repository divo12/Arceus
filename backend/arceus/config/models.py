# LLM model tier configuration

from enum import StrEnum


class AgentTier(StrEnum):
    CEO = "ceo"
    EMPLOYEE = "employee"
    SPAWNED = "spawned"


TIER_MODEL_MAP: dict[AgentTier, str] = {
    AgentTier.CEO: "gpt-5",
    AgentTier.EMPLOYEE: "gpt-4.1-mini",
    AgentTier.SPAWNED: "gpt-4.1-nano",
}

EMBEDDING_MODEL = "text-embedding-3-small"
