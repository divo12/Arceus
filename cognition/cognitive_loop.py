"""ReACT-style cognitive loop for PM decision-making."""

from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional
from uuid import uuid4

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
        available_prompts: Optional[List[str]] = None,
        run_id: Optional[str] = None,
        iteration: int = 1,
        web_evidence: Optional[List[Dict[str, str]]] = None,
        action_result: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        interpreted = self.interpreter.interpret(problem_description, context, available_skills)
        reasoning = self.reasoner.reason(interpreted)
        plan = self.planner.build_plan(reasoning, available_skills, available_prompts)
        decision = self.policy.choose(interpreted, plan)
        reflection = self._reflect(
            interpreted=interpreted,
            reasoning=reasoning,
            plan=plan,
            decision=decision,
            web_evidence=web_evidence or [],
            action_result=action_result or {},
        )

        active_run_id = run_id or str(uuid4())
        episode = {
            "run_id": active_run_id,
            "iteration": iteration,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "problem": problem_description,
            "objectives": interpreted.get("objectives", []),
            "skills_to_use": plan.get("skills_to_use", []),
            "decision": decision.get("decision", ""),
            "reflection": reflection,
        }
        self.memory.record_episode(episode)

        return {
            "run_id": active_run_id,
            "iteration": iteration,
            "interpreted_state": interpreted,
            "reasoning": reasoning,
            "plan": plan,
            "decision": decision,
            "reflection": reflection,
            "iteration_output": {
                "act": decision.get("next_actions", []),
                "reflect": reflection,
            },
            "skills_to_use": plan.get("skills_to_use", []),
            "prompts_to_reference": plan.get("prompts_to_reference", []),
            "memory_snapshot": self.memory.get_memory_snapshot(),
        }

    @staticmethod
    def _reflect(
        interpreted: Dict[str, Any],
        reasoning: Dict[str, Any],
        plan: Dict[str, Any],
        decision: Dict[str, Any],
        web_evidence: List[Dict[str, str]],
        action_result: Dict[str, Any],
    ) -> Dict[str, Any]:
        confidence = decision.get("confidence", 0.5)
        unmet_phases = [
            phase.get("phase", "")
            for phase in plan.get("phases", [])
            if not phase.get("skills", [])
        ]
        learning = "Need more evidence and capabilities before final commitment."
        if confidence >= 0.7 and web_evidence:
            learning = "Confidence improved after grounding with external evidence."
        elif confidence >= 0.7:
            learning = "Current context is sufficient for a provisional recommendation."

        return {
            "confidence": confidence,
            "requires_web_evidence": decision.get("requires_web_evidence", False),
            "web_evidence_count": len(web_evidence),
            "unmet_phases": unmet_phases,
            "learning": learning,
            "next_iteration_focus": (
                "Acquire supporting evidence" if decision.get("requires_web_evidence") else "Refine plan details"
            ),
            "action_result_summary": action_result.get("summary", ""),
            "risk_count": len(reasoning.get("risks", [])),
            "objective_count": len(interpreted.get("objectives", [])),
        }
