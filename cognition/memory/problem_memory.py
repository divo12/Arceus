"""Problem memory: stores initial problem and improvements as the agent learns."""

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


class ProblemMemory:
    """
    Stores the initial problem statement and tracks improvements/changes
    as the agent learns from subagents, feedback, and iterations.
    """

    def __init__(self, workspace: Path):
        self.workspace = Path(workspace).expanduser().resolve()
        self.file_path = self.workspace / "data" / "state" / "problem_memory.json"
        self.file_path.parent.mkdir(parents=True, exist_ok=True)

    def _read(self) -> Dict[str, Any]:
        if not self.file_path.exists():
            return {"problems": {}}
        try:
            data = json.loads(self.file_path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {"problems": {}}
        except (json.JSONDecodeError, OSError):
            return {"problems": {}}

    def _write(self, data: Dict[str, Any]) -> None:
        self.file_path.write_text(json.dumps(data, indent=2), encoding="utf-8")

    def _problem_id(self, problem: str) -> str:
        """Generate a stable id for a problem statement."""
        normalized = problem.strip().lower()
        return hashlib.sha256(normalized.encode()).hexdigest()[:16]

    def record_initial(self, problem: str, run_id: Optional[str] = None) -> str:
        """
        Record the initial problem statement for a run.

        Returns:
            problem_id for this problem.
        """
        data = self._read()
        problems = data.setdefault("problems", {})
        pid = self._problem_id(problem)

        if pid not in problems:
            problems[pid] = {
                "initial": problem,
                "improvements": [],
                "run_ids": [],
                "created_at": datetime.now(timezone.utc).isoformat(),
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }

        entry = problems[pid]
        if run_id and run_id not in entry.get("run_ids", []):
            entry.setdefault("run_ids", []).append(run_id)
        entry["updated_at"] = datetime.now(timezone.utc).isoformat()
        self._write(data)
        return pid

    def append_improvement(
        self,
        problem: str,
        improvement: str,
        source: str = "subagent",
        run_id: Optional[str] = None,
    ) -> None:
        """
        Append an improvement or change to the problem statement.

        Args:
            problem: The problem this improvement relates to.
            improvement: The improvement text (e.g. reframing, new angle).
            source: Where the improvement came from (subagent, feedback, iteration).
            run_id: Optional run id.
        """
        data = self._read()
        problems = data.setdefault("problems", {})
        pid = self._problem_id(problem)

        if pid not in problems:
            self.record_initial(problem, run_id)
            data = self._read()
            problems = data.setdefault("problems", {})

        entry = problems[pid]
        improvements: List[Dict[str, Any]] = entry.get("improvements", [])
        improvements.append({
            "text": improvement,
            "source": source,
            "run_id": run_id,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })
        entry["improvements"] = improvements[-50:]
        entry["updated_at"] = datetime.now(timezone.utc).isoformat()
        self._write(data)

    def get_problem_history(self, problem: str) -> Optional[Dict[str, Any]]:
        """Get full history for a problem (initial + improvements)."""
        data = self._read()
        pid = self._problem_id(problem)
        return data.get("problems", {}).get(pid)
