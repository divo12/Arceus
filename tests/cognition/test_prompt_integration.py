"""Integration tests for skills and cognition (prompts removed; see experiments/ for prompt policy)."""

import shutil
import tempfile
import unittest
from pathlib import Path

import sys

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from agents.context_builder import ContextBuilder
from cognition.cognitive_loop import CognitiveLoop


class TestCognitionIntegration(unittest.TestCase):
    """Integration tests for cognition with skills only."""

    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.workspace = Path(self.temp_dir)

        for name in [
            "problem-statement",
            "problem-framing-canvas",
            "jobs-to-be-done",
            "prioritization-advisor",
            "prd-development",
            "user-story",
            "roadmap-planning",
        ]:
            skill_dir = self.workspace / "skills" / "workspace_skills" / name
            skill_dir.mkdir(parents=True, exist_ok=True)
            (skill_dir / "SKILL.md").write_text(
                f"---\nname: {name}\ndescription: test skill\n---\n\n# {name}",
                encoding="utf-8",
            )

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_cognitive_loop_outputs_skills(self):
        loop = CognitiveLoop(self.workspace)
        result = loop.run(
            problem_description="Users are confused during onboarding.",
            context={"segment": "new users"},
            available_skills=[
                "problem-statement",
                "problem-framing-canvas",
                "jobs-to-be-done",
                "prioritization-advisor",
                "prd-development",
                "user-story",
                "roadmap-planning",
            ],
        )
        self.assertIn("skills_to_use", result)
        self.assertIsInstance(result["skills_to_use"], list)
        self.assertIn("plan", result)

    def test_context_builder_with_skills(self):
        context_builder = ContextBuilder(self.workspace)
        system_prompt = context_builder.build_system_prompt(
            skill_names=["problem-statement"],
        )
        self.assertIn("# Skills", system_prompt)
        self.assertIn("problem-statement", system_prompt)

    def test_build_messages_without_prompts(self):
        context_builder = ContextBuilder(self.workspace)
        messages = context_builder.build_messages(
            history=[],
            current_message="How do we improve onboarding?",
            skill_names=["problem-statement"],
        )
        self.assertGreater(len(messages), 0)
        self.assertEqual(messages[0]["role"], "system")
        self.assertEqual(messages[-1]["role"], "user")


if __name__ == "__main__":
    unittest.main()
