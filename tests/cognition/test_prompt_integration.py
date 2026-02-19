"""Unified tests for prompt integration with skills/cognition/agent."""

import shutil
import tempfile
import unittest
from pathlib import Path

import sys

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from agents.base_agent import BaseAgent
from agents.prompt_policy import PromptPolicy
from agents.prompts import PromptLoader
from cognition.cognitive_loop import CognitiveLoop


class TestPromptIntegration(unittest.TestCase):
    """Single-file integration tests for prompt references."""

    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.workspace = Path(self.temp_dir)

        # Workspace skills (existing capability layer).
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

        # Prompt references under PM_Skills mirror path.
        self.prompts_dir = (
            self.workspace / "PM_Skills" / "product-manager-prompts" / "prompts"
        )
        self.prompts_dir.mkdir(parents=True, exist_ok=True)
        (self.prompts_dir / "framing-the-problem-statement.md").write_text(
            "# framing-the-problem-statement\n\n## Description:\nFrame a problem clearly.\n",
            encoding="utf-8",
        )
        (self.prompts_dir / "user-story-prompt-template.md").write_text(
            "# user-story-prompt-template\n\n## Description:\nStructure user stories with acceptance criteria.\n",
            encoding="utf-8",
        )
        (self.prompts_dir / "visionary-press-release.md").write_text(
            "# visionary-press-release\n\n## Description:\nCommunicate product direction via PR/FAQ style.\n",
            encoding="utf-8",
        )

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_prompt_loader_discovery_and_load(self):
        loader = PromptLoader(self.workspace, self.prompts_dir)
        prompts = loader.list_prompts()
        names = [p["name"] for p in prompts]
        self.assertIn("framing-the-problem-statement", names)
        self.assertIn("user-story-prompt-template", names)

        content = loader.load_prompt("visionary-press-release")
        self.assertIsNotNone(content)
        self.assertIn("Description", content)

    def test_prompt_policy_redundancy_filtering(self):
        policy = PromptPolicy()
        # framing prompt overlaps with selected framing skills and should be skipped.
        selected = policy.select_prompt_references(
            phase_names=["understand", "plan"],
            available_prompts=[
                "framing-the-problem-statement",
                "user-story-prompt-template",
                "visionary-press-release",
            ],
            selected_skills=["problem-statement", "problem-framing-canvas", "user-story"],
        )
        self.assertNotIn("framing-the-problem-statement", selected)
        self.assertIn("visionary-press-release", selected)

    def test_cognitive_loop_outputs_prompt_references(self):
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
            available_prompts=[
                "framing-the-problem-statement",
                "user-story-prompt-template",
                "visionary-press-release",
            ],
        )
        self.assertIn("prompts_to_reference", result)
        self.assertIsInstance(result["prompts_to_reference"], list)

    def test_base_agent_returns_recommended_prompts(self):
        agent = BaseAgent(self.workspace)
        # Force prompt loader to use temp prompt path for deterministic tests.
        agent.prompts = PromptLoader(self.workspace, self.prompts_dir)
        agent.context_builder.prompts = PromptLoader(self.workspace, self.prompts_dir)

        result = agent.process_problem(
            "Users drop off before activation because value is unclear.",
            {"funnel_drop": "step 1"},
        )
        self.assertIn("recommended_prompts", result)
        self.assertIsInstance(result["recommended_prompts"], list)
        self.assertIn("available_prompts", result)

    def test_context_has_separate_prompt_section(self):
        agent = BaseAgent(self.workspace)
        agent.prompts = PromptLoader(self.workspace, self.prompts_dir)
        agent.context_builder.prompts = PromptLoader(self.workspace, self.prompts_dir)

        system_prompt = agent.get_system_prompt(
            skill_names=["problem-statement"],
            prompt_names=["visionary-press-release"],
        )
        self.assertIn("# Skills", system_prompt)
        self.assertIn("# Prompt References", system_prompt)
        self.assertIn("# Selected Prompt References", system_prompt)


if __name__ == "__main__":
    unittest.main()

