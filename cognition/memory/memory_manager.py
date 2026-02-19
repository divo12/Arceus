"""Memory manager that coordinates short-term and long-term memory."""

from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict

from cognition.memory.short_term_memory import ShortTermMemory
from cognition.memory.long_term_memory import LongTermMemory


class MemoryManager:
    """Coordinates memory read/write for the cognitive loop."""

    def __init__(self, workspace: Path):
        self.short_term = ShortTermMemory()
        self.long_term = LongTermMemory(workspace)

    def record_episode(self, episode: Dict[str, Any]) -> None:
        enriched = dict(episode)
        enriched.setdefault("timestamp", datetime.now(timezone.utc).isoformat())
        self.short_term.add(enriched)
        self.long_term.append_episode(enriched)

    def record_trace(self, trace: Dict[str, Any]) -> None:
        enriched = dict(trace)
        enriched.setdefault("timestamp", datetime.now(timezone.utc).isoformat())
        self.short_term.add({"trace": enriched})
        self.long_term.append_trace(enriched)

    def record_run_summary(self, run_summary: Dict[str, Any]) -> None:
        enriched = dict(run_summary)
        enriched.setdefault("timestamp", datetime.now(timezone.utc).isoformat())
        self.long_term.append_run(enriched)

    def remember_fact(self, key: str, value: Any) -> None:
        self.long_term.upsert_fact(key, value)

    def get_memory_snapshot(self) -> Dict[str, Any]:
        return {
            "recent": self.short_term.get_recent(),
            "persistent": self.long_term.read(),
        }
