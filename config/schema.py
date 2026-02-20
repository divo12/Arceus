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


class AgentsConfig(Base):
    """Agent configuration."""

    defaults: AgentDefaults = Field(default_factory=AgentDefaults)


class AzureProviderConfig(Base):
    """Azure OpenAI provider configuration."""

    api_key: str = ""
    endpoint: str = ""
    deployment: str = "gpt-5.2"


class ProvidersConfig(Base):
    """LLM provider configuration."""

    azure: AzureProviderConfig = Field(default_factory=AzureProviderConfig)


class WebSearchConfig(Base):
    """Web search tool configuration (Brave Search API)."""

    api_key: str = ""  # BRAVE_API_KEY fallback from env
    max_results: int = 5


class ExecToolConfig(Base):
    """Shell exec tool configuration."""

    timeout: int = 60


class ToolsConfig(Base):
    """Tools configuration."""

    web: WebSearchConfig = Field(default_factory=WebSearchConfig)
    exec: ExecToolConfig = Field(default_factory=ExecToolConfig)
    restrict_to_workspace: bool = False


class Config(Base):
    """Root configuration for Arceus."""

    agents: AgentsConfig = Field(default_factory=AgentsConfig)
    providers: ProvidersConfig = Field(default_factory=ProvidersConfig)
    tools: ToolsConfig = Field(default_factory=ToolsConfig)

    def get_web_search_api_key(self) -> str:
        """Get web search API key (config or BRAVE_API_KEY env)."""
        key = self.tools.web.api_key
        if key:
            return key
        import os
        return os.environ.get("BRAVE_API_KEY", "")
