"""Coding spawned agent — uses GitHub Copilot SDK + E2B sandbox.

Uses gpt-4.1-nano (Spawned tier).
Specialized for code generation, modification, and testing.
"""

from __future__ import annotations

from arceus.config.models import AgentTier
from arceus.core.agents.base import create_agent
from arceus.core.agents.spawned.generic import SpawnedResult

CODING_SYSTEM_PROMPT = """\
You are a temporary coding agent. You have access to:
- GitHub Copilot SDK for code generation
- E2B sandbox for safe code execution and testing

Your workflow:
1. Read the task requirements carefully.
2. Generate code using Copilot SDK.
3. Execute and test in the E2B sandbox.
4. Report results with file paths and test outcomes.
5. Note any patterns or learnings for future agents.
"""

# TODO: register Copilot SDK and E2B tools with PydanticAI
# Agent is built dynamically at runtime — see create_agent() in base.py
