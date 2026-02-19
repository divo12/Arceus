"""Long-term memory backed by a JSON file in workspace state."""

import json
from pathlib import Path
from typing import Any, Dict, List


class LongTermMemory:
    """Stores persistent cognitive episodes and decisions."""

    DEFAULT_PAYLOAD = {"episodes": [], "facts": {}, "traces": [], "runs": []}

    def __init__(self, workspace: Path):
        self.workspace = workspace
        self.file_path = workspace / "data" / "state" / "cognitive_memory.json"
        self.file_path.parent.mkdir(parents=True, exist_ok=True)

    def read(self) -> Dict[str, Any]:
        if not self.file_path.exists():
            return dict(self.DEFAULT_PAYLOAD)

        try:
            data = json.loads(self.file_path.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                return dict(self.DEFAULT_PAYLOAD)
            merged = dict(self.DEFAULT_PAYLOAD)
            merged.update(data)
            return merged
        except (json.JSONDecodeError, OSError):
            return dict(self.DEFAULT_PAYLOAD)

    def write(self, payload: Dict[str, Any]) -> None:
        self.file_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    def append_episode(self, episode: Dict[str, Any]) -> None:
        data = self.read()
        episodes: List[Dict[str, Any]] = data.get("episodes", [])
        episodes.append(episode)
        data["episodes"] = episodes[-200:]
        self.write(data)

    def append_trace(self, trace: Dict[str, Any]) -> None:
        data = self.read()
        traces: List[Dict[str, Any]] = data.get("traces", [])
        traces.append(trace)
        data["traces"] = traces[-500:]
        self.write(data)

    def append_run(self, run_summary: Dict[str, Any]) -> None:
        data = self.read()
        runs: List[Dict[str, Any]] = data.get("runs", [])
        runs.append(run_summary)
        data["runs"] = runs[-200:]
        self.write(data)

    def upsert_fact(self, key: str, value: Any) -> None:
        data = self.read()
        facts: Dict[str, Any] = data.get("facts", {})
        facts[key] = value
        data["facts"] = facts
        self.write(data)
