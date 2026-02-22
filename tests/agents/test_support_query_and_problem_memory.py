"""Tests for SupportQueryTool and ProblemMemory."""

import tempfile
import unittest
from pathlib import Path

from agents.tools.support_query import SupportQueryTool, _append_skill_learning
from cognition.memory.problem_memory import ProblemMemory


class TestSupportQueryTool(unittest.TestCase):
    """Tests for SupportQueryTool (no provider - fallback mode)."""

    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.workspace = Path(self.temp_dir)
        (self.workspace / "skills" / "workspace_skills" / "prioritization" / "SKILL.md").parent.mkdir(
            parents=True, exist_ok=True
        )
        (self.workspace / "skills" / "workspace_skills" / "prioritization" / "SKILL.md").write_text(
            "---\nname: prioritization\n---\n# Prioritization skill", encoding="utf-8"
        )

    def tearDown(self):
        import shutil
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    async def _run_execute(self, **kwargs):
        tool = SupportQueryTool(self.workspace, provider=None)
        return await tool.execute(**kwargs)

    def test_execute_fallback_without_provider(self):
        """Without provider, returns skill search results."""
        import asyncio
        result = asyncio.run(self._run_execute(query="prioritization"))
        self.assertIn("prioritization", result)
        self.assertIn("Workspace PM skills", result)


class TestProblemMemory(unittest.TestCase):
    """Tests for ProblemMemory."""

    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.workspace = Path(self.temp_dir)
        self.pm = ProblemMemory(self.workspace)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_record_initial(self):
        pid = self.pm.record_initial("Build a grocery app", run_id="run-1")
        self.assertTrue(len(pid) > 0)
        hist = self.pm.get_problem_history("Build a grocery app")
        self.assertIsNotNone(hist)
        self.assertEqual(hist["initial"], "Build a grocery app")
        self.assertEqual(hist["improvements"], [])

    def test_append_improvement(self):
        self.pm.record_initial("Build a grocery app", run_id="run-1")
        self.pm.append_improvement("Build a grocery app", "Consider B2B angle", source="subagent")
        hist = self.pm.get_problem_history("Build a grocery app")
        self.assertEqual(len(hist["improvements"]), 1)
        self.assertEqual(hist["improvements"][0]["text"], "Consider B2B angle")
        self.assertEqual(hist["improvements"][0]["source"], "subagent")


class TestSkillLearningsAppend(unittest.TestCase):
    """Test _append_skill_learning creates references/Learnings.md."""

    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.workspace = Path(self.temp_dir)
        skill_dir = self.workspace / "skills" / "workspace_skills" / "prioritization"
        skill_dir.mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text("---\nname: prioritization\n---\n# Skill", encoding="utf-8")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_append_creates_references_folder_and_learnings_md(self):
        _append_skill_learning(self.workspace, "prioritization", "Use RICE for prioritization.")
        ref_dir = self.workspace / "skills" / "workspace_skills" / "prioritization" / "references"
        learnings = ref_dir / "Learnings.md"
        self.assertTrue(ref_dir.exists())
        self.assertTrue(learnings.exists())
        content = learnings.read_text(encoding="utf-8")
        self.assertIn("Learnings for prioritization", content)
        self.assertIn("Use RICE for prioritization", content)
        self.assertNotIn("SKILL.md", content)
