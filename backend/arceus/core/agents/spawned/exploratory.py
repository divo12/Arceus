"""Exploratory spawned agent — open-ended research and analysis.

Uses gpt-4.1-nano (Spawned tier).
Specialized for brainstorming, analysis, and knowledge gathering.
"""

from __future__ import annotations

from arceus.config.models import AgentTier
from arceus.core.agents.base import create_agent
from arceus.core.agents.spawned.generic import SpawnedResult

EXPLORATORY_SYSTEM_PROMPT = """\
You are a temporary exploratory agent. Your job is research and analysis.

Your capabilities:
- Deep analysis of problems and opportunities
- Market research and competitive analysis
- Technical feasibility assessment
- Creative brainstorming and ideation

Produce structured, actionable findings with clear recommendations.
"""

# Agent is built dynamically at runtime — see create_agent() in base.py
