"""Unified tests for cognition modules and agent integration."""

import shutil
import tempfile
import unittest
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from agents.context_builder import ContextBuilder
from agents.skills import SkillsLoader
from cognition.cognitive_loop import CognitiveLoop
from cognition.decision_policy import DecisionPolicy
from cognition.planner import Planner
from cognition.reasoner import Reasoner
from cognition.state_interpreter import StateInterpreter
from cognition.memory.memory_manager import MemoryManager


class TestCognition(unittest.TestCase):
    """Single-file cognition + agent integration test suite."""

    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.workspace = Path(self.temp_dir)
        (self.workspace / "skills" / "workspace_skills" / "problem-statement").mkdir(parents=True)
        (self.workspace / "skills" / "workspace_skills" / "prioritization-advisor").mkdir(parents=True)
        (self.workspace / "skills" / "workspace_skills" / "prd-development").mkdir(parents=True)
        (self.workspace / "skills" / "workspace_skills" / "user-story").mkdir(parents=True)
        (self.workspace / "skills" / "workspace_skills" / "roadmap-planning").mkdir(parents=True)

        for skill in [
            "problem-statement",
            "prioritization-advisor",
            "prd-development",
            "user-story",
            "roadmap-planning",
        ]:
            (self.workspace / "skills" / "workspace_skills" / skill / "SKILL.md").write_text(
                f"---\nname: {skill}\ndescription: test\n---\n\n# {skill}",
                encoding="utf-8",
            )

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_state_interpreter(self):
        interpreter = StateInterpreter()
        state = interpreter.interpret(
            "Users complain app is slow and revenue is dropping",
            {"platform": "mobile"},
            ["problem-statement"],
        )
        self.assertIn("objectives", state)
        self.assertTrue(state["signals"]["mentions_users"])
        self.assertTrue(state["signals"]["mentions_performance"])

    def test_reasoner(self):
        reasoner = Reasoner()
        reasoning = reasoner.reason(
            {
                "signals": {
                    "mentions_users": True,
                    "mentions_growth": False,
                    "mentions_performance": True,
                    "mentions_revenue": False,
                },
                "objectives": ["Improve user outcomes"],
            }
        )
        self.assertGreater(len(reasoning["hypotheses"]), 0)
        self.assertIn("reasoning_summary", reasoning)

    def test_planner_and_policy(self):
        planner = Planner()
        policy = DecisionPolicy()

        plan = planner.build_plan(
            {"reasoning_summary": "ok"},
            ["problem-statement", "prioritization-advisor", "prd-development"],
        )
        decision = policy.choose({"objectives": ["A"], "signals": {"mentions_users": True}}, plan)

        self.assertIn("skills_to_use", plan)
        self.assertIn("next_actions", decision)
        self.assertEqual(decision["priority"], "high")

    def test_memory_manager(self):
        manager = MemoryManager(self.workspace)
        manager.record_episode({"problem": "x", "decision": "y"})
        snapshot = manager.get_memory_snapshot()
        self.assertEqual(len(snapshot["recent"]), 1)
        self.assertIn("episodes", snapshot["persistent"])

    def test_cognitive_loop(self):
        loop = CognitiveLoop(self.workspace)
        result = loop.run(
            problem_description="Users churn because onboarding is confusing",
            context={"segment": "new users"},
            available_skills=["problem-statement", "prioritization-advisor", "prd-development"],
        )
        self.assertIn("interpreted_state", result)
        self.assertIn("reasoning", result)
        self.assertIn("plan", result)
        self.assertIn("decision", result)
        self.assertIn("skills_to_use", result)

    def test_base_agent_integration(self):
        skills = SkillsLoader(self.workspace)
        context_builder = ContextBuilder(self.workspace)
        loop = CognitiveLoop(self.workspace)
        available_skills = [s["name"] for s in skills.list_skills(filter_unavailable=False)]
        available_prompts = []
        cognition = loop.run(
            problem_description="Users struggle to complete signup",
            context={"funnel_drop": "65% at step 2"},
            available_skills=available_skills,
            available_prompts=available_prompts,
        )
        messages = context_builder.build_messages(
            history=[],
            current_message="Users struggle to complete signup",
            skill_names=cognition.get("skills_to_use"),
            prompt_names=cognition.get("prompts_to_reference"),
        )
        self.assertIn("interpreted_state", cognition)
        self.assertIn("skills_to_use", cognition)
        self.assertGreater(len(messages), 0)


if __name__ == "__main__":
    unittest.main()
