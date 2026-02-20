"""OpenAI client - sync and async Azure OpenAI helpers."""

import asyncio
from typing import TypeVar

from openai import AsyncAzureOpenAI, AzureOpenAI
from pydantic import BaseModel

from settings import Settings
from utils.logger import logger

T = TypeVar("T", bound=BaseModel)
OPENAI_SEMAPHORE = asyncio.Semaphore(25)

# Sync client for get_openai_response
_sync_client = AzureOpenAI(
    azure_endpoint=Settings.AZURE_OPENAI_ENDPOINT,
    api_key=Settings.AZURE_OPENAI_API_KEY,
    api_version="2025-04-01-preview",
)


def get_openai_response(messages, model: str, temperature: float, response_format: dict) -> str:
    """Sync OpenAI chat completion. Returns message content."""
    response = _sync_client.chat.completions.create(
        model=model,
        temperature=temperature,
        response_format=response_format,
        messages=messages,
    )
    return response.choices[0].message.content


class OpenAIProvider:
    """Async Azure OpenAI provider with structured output support."""

    def __init__(self):
        self.client = AsyncAzureOpenAI(
            azure_endpoint=Settings.AZURE_OPENAI_ENDPOINT,
            api_key=Settings.AZURE_OPENAI_API_KEY,
            api_version="2025-04-01-preview",
            timeout=60,
        )

    async def get_openai_response_parsed(
        self,
        messages: list,
        output_model: type[T],
        model: str = "gpt-4o-mini",
        temperature: float = 0.1,
    ) -> T:
        """Get parsed Pydantic response from chat completion."""
        async with OPENAI_SEMAPHORE:
            response = await self.client.chat.completions.parse(
                model=model,
                temperature=temperature,
                response_format=output_model,
                messages=messages,
            )
            result = response.choices[0].message.parsed
            assert isinstance(result, output_model)
            return result

    async def get_openai_response_raw(
        self,
        messages: list,
        output_model,
        model: str = "gpt-4o-mini",
        temperature: float = 0.1,
    ) -> str:
        """Get raw string response with response_format (e.g. json_object)."""
        async with OPENAI_SEMAPHORE:
            response = await self.client.chat.completions.create(
                model=model,
                temperature=temperature,
                response_format=output_model,
                messages=messages,
            )
            result = response.choices[0].message.content
            if not result:
                logger.error("OpenAI Raw returned None response")
                raise Exception("OpenAI RAW failed: Returned None message")
            return result

    async def get_openai_response_json(
        self,
        prompt: str,
        model: str = "gpt-4.1",
        temperature: float = 0.1,
    ) -> str | None:
        """Returns raw JSON string from a single prompt."""
        async with OPENAI_SEMAPHORE:
            messages = [{"role": "user", "content": prompt}]
            response = await self.client.chat.completions.create(
                model=model,
                temperature=temperature,
                response_format={"type": "json_object"},
                messages=messages,
            )
            result = response.choices[0].message.content
            return result if result else None
