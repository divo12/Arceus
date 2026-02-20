"""Tests for config loader (nanobot-style)."""

import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path

import sys

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from config import Config, load_config
from config.loader import get_default_config_paths, save_config


class TestConfigLoader(unittest.TestCase):
    """Config loading and schema tests."""

    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.workspace = Path(self.temp_dir)

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_load_config_returns_defaults_when_no_file(self):
        config = load_config(workspace=self.workspace)
        self.assertIsInstance(config, Config)
        self.assertEqual(config.agents.defaults.model, "gpt-5.2")
        self.assertEqual(config.agents.defaults.max_iterations, 8)
        self.assertEqual(config.agents.defaults.temperature, 0.3)
        self.assertEqual(config.tools.exec.timeout, 60)
        self.assertFalse(config.tools.restrict_to_workspace)

    def test_load_config_from_explicit_path(self):
        path = self.workspace / "custom.json"
        path.write_text(
            json.dumps({
                "agents": {"defaults": {"maxIterations": 4, "temperature": 0.5}},
                "tools": {"exec": {"timeout": 120}, "restrictToWorkspace": True},
            }),
            encoding="utf-8",
        )
        config = load_config(config_path=path)
        self.assertEqual(config.agents.defaults.max_iterations, 4)
        self.assertEqual(config.agents.defaults.temperature, 0.5)
        self.assertEqual(config.tools.exec.timeout, 120)
        self.assertTrue(config.tools.restrict_to_workspace)

    def test_load_config_from_workspace_arceus_dir(self):
        arceus_dir = self.workspace / ".arceus"
        arceus_dir.mkdir(parents=True)
        config_path = arceus_dir / "config.json"
        config_path.write_text(
            json.dumps({"agents": {"defaults": {"maxIterations": 6}}}),
            encoding="utf-8",
        )
        config = load_config(workspace=self.workspace)
        self.assertEqual(config.agents.defaults.max_iterations, 6)

    def test_save_config_roundtrip(self):
        config = Config()
        config.agents.defaults.max_iterations = 10
        path = self.workspace / ".arceus" / "config.json"
        save_config(config, path)
        self.assertTrue(path.exists())
        loaded = load_config(config_path=path)
        self.assertEqual(loaded.agents.defaults.max_iterations, 10)

    def test_get_web_search_api_key_from_config(self):
        path = self.workspace / "config.json"
        path.write_text(
            json.dumps({"tools": {"web": {"apiKey": "test-brave-key"}}}),
            encoding="utf-8",
        )
        config = load_config(config_path=path)
        self.assertEqual(config.get_web_search_api_key(), "test-brave-key")

    def test_get_web_search_api_key_fallback_to_env(self):
        path = self.workspace / "empty.json"
        path.write_text("{}", encoding="utf-8")
        config = load_config(config_path=path)
        orig = os.environ.get("BRAVE_API_KEY")
        try:
            os.environ["BRAVE_API_KEY"] = "env-key"
            self.assertEqual(config.get_web_search_api_key(), "env-key")
        finally:
            if orig is not None:
                os.environ["BRAVE_API_KEY"] = orig
            elif "BRAVE_API_KEY" in os.environ:
                del os.environ["BRAVE_API_KEY"]

    def test_camel_case_aliases_accepted(self):
        path = self.workspace / "camel.json"
        path.write_text(
            json.dumps({
                "agents": {"defaults": {"maxIterations": 3, "maxTokens": 4096}},
                "providers": {"azure": {"deployment": "gpt-4o"}},
            }),
            encoding="utf-8",
        )
        config = load_config(config_path=path)
        self.assertEqual(config.agents.defaults.max_iterations, 3)
        self.assertEqual(config.agents.defaults.max_tokens, 4096)
        self.assertEqual(config.providers.azure.deployment, "gpt-4o")

    def test_agent_loop_uses_config_max_iterations(self):
        from execution.agent_loop import AgentLoop
        from providers.rule_based_provider import RuleBasedProvider

        path = self.workspace / "config.json"
        path.write_text(
            json.dumps({"agents": {"defaults": {"maxIterations": 3}}}),
            encoding="utf-8",
        )
        config = load_config(config_path=path)
        loop = AgentLoop(
            self.workspace,
            provider=RuleBasedProvider(),
            config=config,
        )
        self.assertEqual(loop.max_iterations, 3)


if __name__ == "__main__":
    unittest.main()
