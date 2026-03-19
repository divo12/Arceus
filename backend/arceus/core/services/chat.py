"""ChatService — CEO ↔ User bidirectional chat with PydanticAI streaming.

Per ARCEUS.md: The CEO engages in bidirectional chat with the User to
refine the FundamentalIdea. core_idea is immutable; current_direction evolves.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from typing import Any

from pydantic_ai import Agent
from pydantic_ai.models.openai import OpenAIModel
from pydantic_ai.providers.openai import OpenAIProvider
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from arceus.config.settings import settings
from arceus.db.models.agent import Agent as AgentModel
from arceus.db.models.memory import ChatMessage
from arceus.db.models.startup import Startup

logger = logging.getLogger(__name__)


def _build_ceo_agent(startup: Startup, ceo_row: AgentModel) -> Agent:
    """Build a PydanticAI Agent wired to the configured Azure OpenAI deployment."""
    system_prompt = (
        f"{ceo_row.system_prompt or ''}\n\n"
        f"--- STARTUP CONTEXT ---\n"
        f"Company: {startup.name}\n"
        f"Core Idea (immutable): {startup.core_idea}\n"
        f"Current Direction: {startup.current_direction}\n"
        f"Budget: ${float(startup.budget_allocated):.2f} allocated, "
        f"${float(startup.budget_spent):.2f} spent\n"
    )

    # Build the model — try Azure OpenAI first, fall back to OpenAI
    if settings.azure_openai_endpoint and settings.azure_openai_api_key:
        from openai import AsyncAzureOpenAI

        client = AsyncAzureOpenAI(
            azure_endpoint=settings.azure_openai_endpoint,
            api_key=settings.azure_openai_api_key,
            api_version=settings.azure_openai_api_version,
        )
        provider = OpenAIProvider(openai_client=client)
        model = OpenAIModel(settings.model_ceo, provider=provider)
    else:
        # Plain OpenAI fallback (uses OPENAI_API_KEY env var)
        model = OpenAIModel(settings.model_ceo)

    return Agent(model=model, system_prompt=system_prompt)


class ChatService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def _get_startup_and_ceo(
        self, startup_id: str
    ) -> tuple[Startup, AgentModel] | tuple[None, None]:
        startup = await self.session.get(Startup, startup_id)
        if not startup:
            return None, None
        result = await self.session.execute(
            select(AgentModel).where(
                AgentModel.startup_id == startup_id,
                AgentModel.role == "CEO",
            )
        )
        ceo = result.scalar_one_or_none()
        return startup, ceo

    async def _load_history(self, startup_id: str) -> list[dict[str, str]]:
        """Load full chat history as PydanticAI message format."""
        result = await self.session.execute(
            select(ChatMessage)
            .where(ChatMessage.startup_id == startup_id)
            .order_by(ChatMessage.created_at)
        )
        messages: list[dict[str, str]] = []
        for msg in result.scalars().all():
            if msg.role == "user":
                messages.append({"role": "user", "content": msg.content})
            else:
                messages.append({"role": "assistant", "content": msg.content})
        return messages

    async def send_message_stream(
        self, startup_id: str, user_message: str
    ) -> AsyncIterator[str]:
        """Store user message, run CEO agent, stream response tokens, store result."""
        startup, ceo = await self._get_startup_and_ceo(startup_id)
        if not startup or not ceo:
            yield "[error] Startup or CEO not found"
            return

        # 1. Persist user message
        user_msg = ChatMessage(
            startup_id=startup_id, role="user", content=user_message
        )
        self.session.add(user_msg)
        await self.session.flush()

        # 2. Build conversation history for the agent
        history = await self._load_history(startup_id)
        # Remove the last user message since we'll pass it as the prompt
        if history and history[-1]["role"] == "user":
            history = history[:-1]

        # 3. Build agent and run with streaming
        agent = _build_ceo_agent(startup, ceo)

        full_response = ""
        try:
            async with agent.run_stream(
                user_message,
                message_history=history,  # type: ignore[arg-type]
            ) as result:
                async for chunk in result.stream_text(delta=True):
                    full_response += chunk
                    yield chunk
        except Exception as e:
            logger.exception("CEO agent error for startup %s", startup_id)
            error_msg = f"I encountered an issue processing your message. Error: {e}"
            full_response = error_msg
            yield error_msg

        # 4. Persist CEO response
        ceo_msg = ChatMessage(
            startup_id=startup_id, role="assistant", content=full_response
        )
        self.session.add(ceo_msg)
        await self.session.flush()

    async def get_history(
        self, startup_id: str, limit: int = 50, offset: int = 0
    ) -> list[ChatMessage]:
        result = await self.session.execute(
            select(ChatMessage)
            .where(ChatMessage.startup_id == startup_id)
            .order_by(ChatMessage.created_at)
            .limit(limit)
            .offset(offset)
        )
        return list(result.scalars().all())
