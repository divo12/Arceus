"""Configuration schema using Pydantic (adapted from nanobot)."""

from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class Base(BaseModel):
    """Base model that accepts both camelCase and snake_case keys."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class AgentDefaults(Base):
    """Default agent configuration."""

    model: str = "gpt-5.2"
    max_iterations: int = 8
    temperature: float = 0.3
    max_tokens: int = 8192


class PMLoopConfig(Base):
    """Continuous PM loop governance settings."""

    enabled: bool = True
    max_cycles_per_run: int = 1
    cooldown_seconds: int = 0
    simulate_feedback: bool = True
    deduplicate_problems: bool = True
    recent_cycle_summaries: int = 2
    kill_switch: bool = False


class AgentsConfig(Base):
    """Agent configuration."""

    defaults: AgentDefaults = Field(default_factory=AgentDefaults)
    pm_loop: PMLoopConfig = Field(default_factory=PMLoopConfig)


class AzureProviderConfig(Base):
    """Azure OpenAI provider configuration."""

    api_key: str = ""
    endpoint: str = ""
    deployment: str = "gpt-5.2"


class ProvidersConfig(Base):
    """LLM provider configuration."""

    azure: AzureProviderConfig = Field(default_factory=AzureProviderConfig)


class WebSearchConfig(Base):
    """Web search tool configuration (Google Custom Search)."""

    google_api_key: str = ""  # GOOGLE_API_KEY fallback from env
    google_search_engine_id: str = ""  # GOOGLE_SEARCH_ENGINE_ID fallback from env
    max_results: int = 5


class ExecToolConfig(Base):
    """Shell exec tool configuration."""

    timeout: int = 60


class MCPServerConfig(Base):
    """MCP server config (stdio or HTTP)."""

    command: str = ""
    args: list[str] = Field(default_factory=list)
    env: dict[str, str] = Field(default_factory=dict)
    url: str = ""


class ToolsConfig(Base):
    """Tools configuration."""

    web: WebSearchConfig = Field(default_factory=WebSearchConfig)
    exec: ExecToolConfig = Field(default_factory=ExecToolConfig)
    restrict_to_workspace: bool = False
    mcp_servers: dict[str, MCPServerConfig] = Field(default_factory=dict)


class ConsoleConfig(Base):
    """Console/chat channel config (nanobot-style). Empty allow_from = allow all."""

    allow_from: list[str] = Field(default_factory=list)


class ChannelsConfig(Base):
    """Channel configuration (for future Discord, Slack, etc.)."""

    console: ConsoleConfig = Field(default_factory=ConsoleConfig)


class Config(Base):
    """Root configuration for Arceus."""

    agents: AgentsConfig = Field(default_factory=AgentsConfig)
    providers: ProvidersConfig = Field(default_factory=ProvidersConfig)
    tools: ToolsConfig = Field(default_factory=ToolsConfig)
    channels: ChannelsConfig = Field(default_factory=ChannelsConfig)

    def get_google_search_config(self) -> tuple[str, str]:
        """Get Google Custom Search config (api_key, search_engine_id)."""
        import os
        key = self.tools.web.google_api_key or os.environ.get("GOOGLE_API_KEY", "")
        cx = self.tools.web.google_search_engine_id or os.environ.get("GOOGLE_SEARCH_ENGINE_ID", "")
        return (key, cx)
