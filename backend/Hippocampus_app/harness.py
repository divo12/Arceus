"""Hippocampus verification harness — LLM-in-the-loop agent that uses remember/recall."""

from __future__ import annotations

import sys
from pathlib import Path

# Allow imports from the backend package.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from arceus.core.hippocampus.config import HippocampusConfig
from arceus.core.hippocampus.hippocampus import Hippocampus
from arceus.core.hippocampus.types import MemoryType, MemoryUnit
from arceus.core.memory_scope import ArceusMemoryScope

from Hippocampus_app.llm_client import AsyncAzureOpenAI, chat, create_client


SYSTEM_PROMPT = (
    "You are an AI employee at a startup managed by the Arceus platform. "
    "You have a persistent memory system. Before each response you receive "
    "relevant memories retrieved from your memory store. Use them to stay "
    "consistent, avoid repeating questions, and build on past context.\n\n"
    "MEMORIES:\n{memories}\n\n"
    "Answer concisely. If a memory contradicts the user, trust the user and "
    "note you are updating your understanding."
)


def _format_memories(units: list[MemoryUnit]) -> str:
    if not units:
        return "(no relevant memories)"
    lines: list[str] = []
    for i, unit in enumerate(units, 1):
        tag = unit.memory_type.value.upper()
        lines.append(f"[{i}] [{tag}] {unit.content}")
    return "\n".join(lines)


async def agent_turn(
    hippocampus: Hippocampus,
    client: AsyncAzureOpenAI,
    container: str,
    user_message: str,
    deployment: str | None = None,
) -> tuple[str, list[MemoryUnit]]:
    """Single agent turn: recall → prompt → respond → remember."""

    # 1. Recall
    recalled = await hippocampus.recall(user_message, container, top_k=5)
    memory_block = _format_memories(recalled)

    # 2. Build prompt
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT.format(memories=memory_block)},
        {"role": "user", "content": user_message},
    ]

    # 3. LLM call
    response = await chat(client, messages, deployment=deployment)

    # 4. Remember the exchange as dynamic memory
    await hippocampus.remember(
        content=f"User said: {user_message}\nI responded: {response}",
        container=container,
        memory_type=MemoryType.DYNAMIC,
    )

    return response, recalled
