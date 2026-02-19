"""Long-term memory backed by a JSON file in workspace state."""

import json
from pathlib import Path
from typing import Any, Dict, List


class LongTermMemory:
    """Stores persistent cognitive episodes and decisions."""

    def __init__(self, workspace: Path):
        self.workspace = workspace
        self.file_path = workspace / "data" / "state" / "cognitive_memory.json"
        self.file_path.parent.mkdir(parents=True, exist_ok=True)

    def read(self) -> Dict[str, Any]:
        if not self.file_path.exists():
            return {"episodes": [], "facts": {}}

        try:
            return json.loads(self.file_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return {"episodes": [], "facts": {}}

    def write(self, payload: Dict[str, Any]) -> None:
        self.file_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    def append_episode(self, episode: Dict[str, Any]) -> None:
        data = self.read()
        episodes: List[Dict[str, Any]] = data.get("episodes", [])
        episodes.append(episode)
        data["episodes"] = episodes[-200:]
        self.write(data)
