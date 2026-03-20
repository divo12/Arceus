"""Shared LLM model factory — single place to build PydanticAI models.

Eliminates duplication across chat.py, hierarchy.py, executor.py, meeting.py.
"""

from __future__ import annotations

from pydantic_ai.models.openai import OpenAIModel
from pydantic_ai.providers.openai import OpenAIProvider

from arceus.config.settings import settings

# Cache the client so we don't create a new one per call
_azure_client = None


def _get_azure_client():
    global _azure_client
    if _azure_client is None:
        from openai import AsyncAzureOpenAI

        _azure_client = AsyncAzureOpenAI(
            azure_endpoint=settings.azure_openai_endpoint,
            api_key=settings.azure_openai_api_key.get_secret_value(),
            api_version=settings.azure_openai_api_version,
        )
    return _azure_client


def build_model(deployment: str | None = None) -> OpenAIModel:
    """Build a PydanticAI OpenAIModel for the given deployment.

    Args:
        deployment: Azure OpenAI deployment name. Defaults to settings.model_ceo.

    Returns:
        OpenAIModel ready for use with PydanticAI Agent.
    """
    model_name = deployment or settings.model_ceo

    if settings.azure_openai_endpoint and settings.azure_openai_api_key.get_secret_value():
        client = _get_azure_client()
        provider = OpenAIProvider(openai_client=client)
        return OpenAIModel(model_name, provider=provider)
    else:
        return OpenAIModel(model_name)
