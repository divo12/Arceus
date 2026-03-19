from __future__ import annotations

import os
from pathlib import Path

from dotenv import dotenv_values

from arceus.config.settings import settings

_DOTENV_VALUES = dotenv_values(Path(__file__).resolve().parents[4] / ".env")


def resolve_env(name: str, default: str = "") -> str:
    """Resolve an env var with ARCEUS_ prefix fallback, .env, and settings default."""
    return (
        str(_DOTENV_VALUES.get(name) or "")
        or str(_DOTENV_VALUES.get(f"ARCEUS_{name}") or "")
        or os.getenv(name)
        or os.getenv(f"ARCEUS_{name}")
        or default
    )
