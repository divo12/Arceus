"""Comprehensive tests for the SkillsLoader class using unittest."""

import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

# Add parent directory to path for imports
import sys
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from agents.skills import SkillsLoader, ESSENTIAL_SKILLS_DIR, OPEN_SKILLS_DIR


class TestSkillsLoader(unittest.TestCase):
    """Comprehensive test suite for SkillsLoader."""
    
    def setUp(self):
        """Set up test fixtures."""
        self.temp_dir = tempfile.mkdtemp()
        self.workspace = Path(self.temp_dir)
        self.workspace_skills_dir = self.workspace / "skills" / "workspace_skills"
        self.essential_skills_dir = self.workspace / "skills" / "essential"
        self.open_skills_dir = self.workspace / "skills" / "open_skills"
        
        # Create directory structure
        self.workspace_skills_dir.mkdir(parents=True)
        self.essential_skills_dir.mkdir(parents=True)
        self.open_skills_dir.mkdir(parents=True)
        
        self.loader = SkillsLoader(
            self.workspace,
            essential_skills_dir=self.essential_skills_dir,
            open_skills_dir=self.open_skills_dir,
        )
    
    def tearDown(self):
        """Clean up test fixtures."""
        shutil.rmtree(self.temp_dir, ignore_errors=True)
    
    def create_test_skill(self, name: str, content: str, in_workspace: bool = True):
        """Helper to create a test skill."""
        if in_workspace:
            skill_dir = self.workspace_skills_dir / name
        else:
            skill_dir = self.open_skills_dir / name
        
        skill_dir.mkdir(exist_ok=True)
        skill_file = skill_dir / "SKILL.md"
        skill_file.write_text(content, encoding="utf-8")
        return skill_file
    
    # Initialization tests
    def test_init(self):
        """Test SkillsLoader initialization."""
        loader = SkillsLoader(
            self.workspace,
            essential_skills_dir=self.essential_skills_dir,
            open_skills_dir=self.open_skills_dir,
        )
        self.assertEqual(loader.workspace, self.workspace)
        self.assertEqual(loader.workspace_skills, self.workspace_skills_dir)
        self.assertEqual(loader.essential_skills, self.essential_skills_dir)
        self.assertEqual(loader.open_skills, self.open_skills_dir)
    
    # List skills tests
    def test_list_skills_empty(self):
        """Test listing skills when none exist."""
        skills = self.loader.list_skills()
        self.assertEqual(skills, [])
    
    def test_list_skills_workspace(self):
        """Test listing workspace skills."""
        self.create_test_skill("test-skill", "# Test Skill\n\nThis is a test.")
        skills = self.loader.list_skills(filter_unavailable=False)
        self.assertEqual(len(skills), 1)
        self.assertEqual(skills[0]["name"], "test-skill")
        self.assertEqual(skills[0]["source"], "workspace")
        self.assertIn("SKILL.md", skills[0]["path"])
    
    def test_list_skills_open(self):
        """Test listing open skills."""
        self.create_test_skill("open-skill", "# Open Skill", in_workspace=False)
        skills = self.loader.list_skills(filter_unavailable=False)
        self.assertEqual(len(skills), 1)
        self.assertEqual(skills[0]["name"], "open-skill")
        self.assertEqual(skills[0]["source"], "open")
    
    def test_list_skills_workspace_priority(self):
        """Test that workspace skills take priority over open."""
        self.create_test_skill("duplicate-skill", "# Workspace Version", in_workspace=True)
        self.create_test_skill("duplicate-skill", "# Open Version", in_workspace=False)
        
        skills = self.loader.list_skills(filter_unavailable=False)
        self.assertEqual(len(skills), 1)
        self.assertEqual(skills[0]["name"], "duplicate-skill")
        self.assertEqual(skills[0]["source"], "workspace")
    
    def test_list_skills_filter_unavailable(self):
        """Test filtering unavailable skills."""
        content = """---
metadata: '{"nanobot": {"requires": {"bins": ["nonexistent-tool"]}}}'
---

# Skill
"""
        self.create_test_skill("unavailable-skill", content)
        
        with patch('agents.skills.shutil.which', return_value=None):
            skills = self.loader.list_skills(filter_unavailable=True)
            self.assertEqual(len(skills), 0)
        
        with patch('agents.skills.shutil.which', return_value="/usr/bin/tool"):
            skills = self.loader.list_skills(filter_unavailable=True)
            self.assertEqual(len(skills), 1)
    
    # Load skill tests
    def test_load_skill_workspace(self):
        """Test loading a workspace skill."""
        content = "# Test Skill\n\nThis is a test skill."
        self.create_test_skill("test-skill", content)
        
        loaded = self.loader.load_skill("test-skill")
        self.assertEqual(loaded, content)
    
    def test_load_skill_open(self):
        """Test loading an open skill."""
        content = "# Open Skill\n\nThis is an open skill."
        self.create_test_skill("open-skill", content, in_workspace=False)
        
        loaded = self.loader.load_skill("open-skill")
        self.assertEqual(loaded, content)
    
    def test_load_skill_not_found(self):
        """Test loading a non-existent skill."""
        loaded = self.loader.load_skill("nonexistent-skill")
        self.assertIsNone(loaded)
    
    def test_load_skill_workspace_priority(self):
        """Test that workspace skills are loaded before open."""
        workspace_content = "# Workspace Version"
        open_content = "# Open Version"
        
        self.create_test_skill("test-skill", workspace_content, in_workspace=True)
        self.create_test_skill("test-skill", open_content, in_workspace=False)
        
        loaded = self.loader.load_skill("test-skill")
        self.assertEqual(loaded, workspace_content)
    
    # Load skills for context tests
    def test_load_skills_for_context(self):
        """Test loading multiple skills for context."""
        self.create_test_skill("skill1", "# Skill 1\n\nContent 1")
        self.create_test_skill("skill2", "# Skill 2\n\nContent 2")
        
        result = self.loader.load_skills_for_context(["skill1", "skill2"])
        self.assertIn("### Skill: skill1", result)
        self.assertIn("### Skill: skill2", result)
        self.assertIn("Content 1", result)
        self.assertIn("Content 2", result)
        self.assertIn("---", result)
    
    def test_load_skills_for_context_missing(self):
        """Test loading skills when some are missing."""
        self.create_test_skill("skill1", "# Skill 1")
        
        result = self.loader.load_skills_for_context(["skill1", "missing-skill"])
        self.assertIn("### Skill: skill1", result)
        self.assertNotIn("### Skill: missing-skill", result)
    
    # Frontmatter and metadata tests
    def test_strip_frontmatter(self):
        """Test stripping YAML frontmatter."""
        content = """---
description: Test skill
---

# Skill Content
This is the actual content.
"""
        stripped = self.loader._strip_frontmatter(content)
        self.assertNotIn("description: Test skill", stripped)
        self.assertIn("# Skill Content", stripped)
        self.assertIn("This is the actual content.", stripped)
    
    def test_strip_frontmatter_no_frontmatter(self):
        """Test stripping when no frontmatter exists."""
        content = "# Skill Content\n\nNo frontmatter here."
        stripped = self.loader._strip_frontmatter(content)
        self.assertEqual(stripped, content)
    
    def test_get_skill_metadata(self):
        """Test getting skill metadata from frontmatter."""
        content = """---
description: A test skill
author: Test Author
---

# Skill Content
"""
        self.create_test_skill("test-skill", content)
        
        metadata = self.loader.get_skill_metadata("test-skill")
        self.assertIsNotNone(metadata)
        self.assertEqual(metadata.get("description"), "A test skill")
        self.assertEqual(metadata.get("author"), "Test Author")
    
    def test_get_skill_metadata_no_frontmatter(self):
        """Test getting metadata when no frontmatter exists."""
        content = "# Skill Content"
        self.create_test_skill("test-skill", content)
        
        metadata = self.loader.get_skill_metadata("test-skill")
        self.assertIsNone(metadata)
    
    def test_get_skill_description(self):
        """Test getting skill description."""
        content = """---
description: This is a test skill
---

# Content
"""
        self.create_test_skill("test-skill", content)
        
        desc = self.loader._get_skill_description("test-skill")
        self.assertEqual(desc, "This is a test skill")
    
    def test_get_skill_description_fallback(self):
        """Test description fallback to skill name."""
        content = "# Skill Content"
        self.create_test_skill("test-skill", content)
        
        desc = self.loader._get_skill_description("test-skill")
        self.assertEqual(desc, "test-skill")
    
    # Nanobot metadata parsing tests
    def test_parse_nanobot_metadata(self):
        """Test parsing nanobot metadata."""
        metadata_json = '{"nanobot": {"requires": {"bins": ["git"]}, "always": true}}'
        result = self.loader._parse_nanobot_metadata(metadata_json)
        self.assertEqual(result.get("requires"), {"bins": ["git"]})
        self.assertTrue(result.get("always"))
    
    def test_parse_nanobot_metadata_openclaw(self):
        """Test parsing openclaw metadata."""
        metadata_json = '{"openclaw": {"requires": {"env": ["API_KEY"]}}}'
        result = self.loader._parse_nanobot_metadata(metadata_json)
        self.assertEqual(result.get("requires"), {"env": ["API_KEY"]})
    
    def test_parse_nanobot_metadata_invalid(self):
        """Test parsing invalid metadata."""
        result = self.loader._parse_nanobot_metadata("not json")
        self.assertEqual(result, {})
    
    # Requirements checking tests
    @patch('agents.skills.shutil.which')
    def test_check_requirements_bins(self, mock_which):
        """Test checking binary requirements."""
        mock_which.return_value = "/usr/bin/git"
        
        skill_meta = {"requires": {"bins": ["git"]}}
        self.assertTrue(self.loader._check_requirements(skill_meta))
        
        mock_which.return_value = None
        self.assertFalse(self.loader._check_requirements(skill_meta))
    
    @patch.dict(os.environ, {"API_KEY": "test-key"})
    def test_check_requirements_env(self):
        """Test checking environment variable requirements."""
        skill_meta = {"requires": {"env": ["API_KEY"]}}
        self.assertTrue(self.loader._check_requirements(skill_meta))
        
        skill_meta = {"requires": {"env": ["MISSING_KEY"]}}
        self.assertFalse(self.loader._check_requirements(skill_meta))
    
    def test_check_requirements_no_requirements(self):
        """Test checking skills with no requirements."""
        skill_meta = {}
        self.assertTrue(self.loader._check_requirements(skill_meta))
    
    def test_get_missing_requirements(self):
        """Test getting missing requirements."""
        skill_meta = {
            "requires": {
                "bins": ["git", "nonexistent"],
                "env": ["API_KEY", "MISSING_KEY"]
            }
        }
        
        with patch('agents.skills.shutil.which') as mock_which:
            mock_which.side_effect = lambda x: "/usr/bin/git" if x == "git" else None
            
            with patch.dict(os.environ, {"API_KEY": "test"}, clear=False):
                missing = self.loader._get_missing_requirements(skill_meta)
                self.assertIn("CLI: nonexistent", missing)
                self.assertIn("ENV: MISSING_KEY", missing)
                self.assertNotIn("CLI: git", missing)
                self.assertNotIn("ENV: API_KEY", missing)
    
    # Skills summary tests
    def test_build_skills_summary(self):
        """Test building skills summary."""
        content = """---
description: A test skill
---

# Content
"""
        self.create_test_skill("test-skill", content)
        
        summary = self.loader.build_skills_summary()
        self.assertIn("<skills>", summary)
        self.assertIn("<skill", summary)
        self.assertIn("test-skill", summary)
        self.assertIn("A test skill", summary)
        self.assertIn("</skills>", summary)
    
    def test_build_skills_summary_empty(self):
        """Test building summary when no skills exist."""
        summary = self.loader.build_skills_summary()
        self.assertEqual(summary, "")
    
    # Always skills tests
    def test_get_always_skills(self):
        """Test getting always skills (essential by location + always=true in frontmatter)."""
        # Essential skill: always loaded by location
        essential_dir = self.essential_skills_dir / "essential-skill"
        essential_dir.mkdir(parents=True)
        (essential_dir / "SKILL.md").write_text("# Essential Skill")
        # Open skill with always=true
        content1 = """---
metadata: '{"nanobot": {"always": true}}'
---

# Skill 1
"""
        content2 = """---
always: true
---

# Skill 2
"""
        self.create_test_skill("always-skill-1", content1)
        self.create_test_skill("always-skill-2", content2)
        self.create_test_skill("normal-skill", "# Normal Skill")
        
        always_skills = self.loader.get_always_skills()
        self.assertIn("essential-skill", always_skills)
        self.assertIn("always-skill-1", always_skills)
        self.assertIn("always-skill-2", always_skills)
        self.assertNotIn("normal-skill", always_skills)


if __name__ == "__main__":
    unittest.main()
