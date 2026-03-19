"""Browser spawned agent — uses browser-use for web interaction.

Uses gpt-4.1-nano (Spawned tier).
Specialized for web scraping, research, and form-filling.
"""

from __future__ import annotations

from arceus.config.models import AgentTier
from arceus.core.agents.base import create_agent
from arceus.core.agents.spawned.generic import SpawnedResult

BROWSER_SYSTEM_PROMPT = """\
You are a temporary browser agent. You have access to browser-use for web interaction.

Your capabilities:
- Navigate websites and extract information
- Fill forms and interact with web UIs
- Take screenshots of pages
- Research topics across multiple sources

Complete your browsing task and report findings clearly.
"""

# TODO: register browser-use tools with PydanticAI
# Agent is built dynamically at runtime — see create_agent() in base.py
