"""Planning module for turning reasoning into a phased plan."""

from typing import Any, Dict, List


class Planner:
    """Builds a practical plan using the available skills inventory."""

    _PHASE_TO_SKILLS = {
        "understand": ["problem-statement", "problem-framing-canvas", "discovery-process"],
        "validate": ["jobs-to-be-done", "company-research", "pol-probe"],
        "decide": ["prioritization-advisor", "product-strategy-session", "opportunity-solution-tree"],
        "plan": ["prd-development", "user-story", "roadmap-planning"],
    }

    def build_plan(self, reasoning: Dict[str, Any], available_skills: List[str]) -> Dict[str, Any]:
        phases: List[Dict[str, Any]] = []

        for phase_name in ["understand", "validate", "decide", "plan"]:
            desired = self._PHASE_TO_SKILLS.get(phase_name, [])
            selected = [skill for skill in desired if skill in available_skills]
            phases.append(
                {
                    "phase": phase_name,
                    "skills": selected,
                    "goal": self._phase_goal(phase_name),
                }
            )

        skills_to_use: List[str] = []
        for phase in phases:
            skills_to_use.extend(phase["skills"])

        return {
            "phases": phases,
            "skills_to_use": skills_to_use,
            "execution_order": [phase["phase"] for phase in phases],
            "reasoning_summary": reasoning.get("reasoning_summary", ""),
        }

    @staticmethod
    def _phase_goal(phase_name: str) -> str:
        goals = {
            "understand": "Define the real problem, scope, and expected outcome.",
            "validate": "Test assumptions with user and market evidence.",
            "decide": "Prioritize what to build and why now.",
            "plan": "Create implementation-ready plan and artifacts.",
        }
        return goals.get(phase_name, "Execute the next best action.")
