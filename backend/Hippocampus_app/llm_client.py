"""Thin Azure OpenAI wrapper for the Hippocampus verification harness."""

from __future__ import annotations

import os

from openai import AsyncAzureOpenAI


def create_client() -> AsyncAzureOpenAI:
    return AsyncAzureOpenAI(
        azure_endpoint=os.environ["AZURE_OPENAI_ENDPOINT"],
        api_key=os.environ["AZURE_OPENAI_API_KEY"],
        api_version=os.environ.get("AZURE_OPENAI_API_VERSION", "2024-12-01-preview"),
    )


async def chat(
    client: AsyncAzureOpenAI,
    messages: list[dict],
    deployment: str | None = None,
) -> str:
    deployment = deployment or os.environ.get(
        "AZURE_OPENAI_DEPLOYMENT_REASONING", "gpt-4o"
    )
    response = await client.chat.completions.create(
        model=deployment,
        messages=messages,
        temperature=0.3,
        max_tokens=1024,
    )
    return response.choices[0].message.content or ""
