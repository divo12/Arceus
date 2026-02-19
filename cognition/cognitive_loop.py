"""ReACT-style cognitive loop for PM decision-making."""

from pathlib import Path
from typing import Any, Dict, List, Optional

from cognition.decision_policy import DecisionPolicy
from cognition.memory.memory_manager import MemoryManager
from cognition.planner import Planner
from cognition.reasoner import Reasoner
from cognition.state_interpreter import StateInterpreter


class CognitiveLoop:
    """Core think-plan-decide loop used by the agent."""

    def __init__(self, workspace: Path):
        self.workspace = workspace
        self.interpreter = StateInterpreter()
        self.reasoner = Reasoner()
        self.planner = Planner()
        self.policy = DecisionPolicy()
        self.memory = MemoryManager(workspace)

    def run(
        self,
        problem_description: str,
        context: Optional[Dict[str, Any]],
        available_skills: List[str],
    ) -> Dict[str, Any]:
        interpreted = self.interpreter.interpret(problem_description, context, available_skills)
        reasoning = self.reasoner.reason(interpreted)
        plan = self.planner.build_plan(reasoning, available_skills)
        decision = self.policy.choose(interpreted, plan)

        episode = {
            "problem": problem_description,
            "objectives": interpreted.get("objectives", []),
            "skills_to_use": plan.get("skills_to_use", []),
            "decision": decision.get("decision", ""),
        }
        self.memory.record_episode(episode)

        return {
            "interpreted_state": interpreted,
            "reasoning": reasoning,
            "plan": plan,
            "decision": decision,
            "skills_to_use": plan.get("skills_to_use", []),
            "memory_snapshot": self.memory.get_memory_snapshot(),
        }
