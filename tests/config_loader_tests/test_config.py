"""Tests for config loader (nanobot-style)."""

import io
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import sys

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from config import Config, load_config
from config.loader import find_config_path, get_default_config_paths, save_config


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
        from providers.adapter import ProviderAdapter, ProviderResponse

        class _TestProvider(ProviderAdapter):
            async def complete(self, messages, tool_schemas, iteration, runtime_context):
                return ProviderResponse(content="ok", done=True)

        path = self.workspace / "config.json"
        path.write_text(
            json.dumps({"agents": {"defaults": {"maxIterations": 3}}}),
            encoding="utf-8",
        )
        config = load_config(config_path=path)
        provider = _TestProvider()
        loop = AgentLoop(
            self.workspace,
            provider=provider,
            config=config,
        )
        self.assertEqual(loop.max_iterations, 3)

    def test_find_config_path_returns_workspace_config_when_present(self):
        """When workspace has .arceus/config.json, find_config_path returns it."""
        arceus = self.workspace / ".arceus"
        arceus.mkdir(parents=True)
        cfg = arceus / "config.json"
        cfg.write_text("{}", encoding="utf-8")
        found = find_config_path(workspace=self.workspace)
        self.assertIsNotNone(found)
        self.assertTrue(found.exists())
        self.assertEqual(found.resolve(), cfg.resolve())

    def test_mcp_servers_in_config_schema(self):
        path = self.workspace / "mcp.json"
        path.write_text(
            json.dumps({
                "tools": {
                    "mcpServers": {
                        "fs": {
                            "command": "npx",
                            "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
                            "env": {"FOO": "bar"},
                            "url": ""
                        }
                    }
                }
            }),
            encoding="utf-8",
        )
        config = load_config(config_path=path)
        self.assertIn("fs", config.tools.mcp_servers)
        self.assertEqual(config.tools.mcp_servers["fs"].command, "npx")
        self.assertEqual(config.tools.mcp_servers["fs"].args, ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"])
        self.assertEqual(config.tools.mcp_servers["fs"].env, {"FOO": "bar"})

    def test_status_command_output(self):
        """run_status produces expected output format."""
        import io
        import sys
        from main import run_status

        out = io.StringIO()
        with mock.patch("sys.stdout", out):
            run_status(workspace=self.workspace)
        text = out.getvalue()
        self.assertIn("Arceus status", text)
        self.assertIn("Config:", text)
        self.assertIn("Provider:", text)
        self.assertIn("Cron jobs:", text)
        self.assertIn("Sessions:", text)

    def test_onboard_creates_files(self):
        """run_onboard creates config, sessions, skills, HEARTBEAT.md when missing."""
        from main import run_onboard

        run_onboard(workspace=self.workspace)
        self.assertTrue((self.workspace / ".arceus" / "config.json").exists())
        self.assertTrue((self.workspace / "sessions").is_dir())
        self.assertTrue((self.workspace / "skills" / "workspace_skills").is_dir())
        self.assertTrue((self.workspace / "HEARTBEAT.md").exists())
        content = (self.workspace / "HEARTBEAT.md").read_text()
        self.assertIn("Heartbeat", content)

    def test_onboard_idempotent(self):
        """run_onboard does not overwrite existing HEARTBEAT.md."""
        from main import run_onboard

        heartbeat = self.workspace / "HEARTBEAT.md"
        heartbeat.write_text("# Custom\n\nMy tasks", encoding="utf-8")
        run_onboard(workspace=self.workspace)
        self.assertEqual(heartbeat.read_text(), "# Custom\n\nMy tasks")

    def test_chat_plain_text_with_no_markdown(self):
        """run_chat with use_markdown=False produces plain text output."""
        from main import run_chat

        inputs = ["hello", "exit"]
        mock_session = mock.MagicMock()
        mock_session.prompt.side_effect = inputs
        with mock.patch("prompt_toolkit.PromptSession", return_value=mock_session):
            with mock.patch("execution.controller.Controller") as MockCtrl:
                mock_result = {"final": {"content": "Hi there!"}}
                MockCtrl.return_value.run_problem.return_value = mock_result
                out = io.StringIO()
                with mock.patch("sys.stdout", out):
                    run_chat(session_key="test:plain", use_markdown=False, workspace=self.workspace)
        text = out.getvalue()
        self.assertIn("Arceus:", text)
        self.assertIn("Hi there!", text)

    def test_chat_markdown_renders_via_rich(self):
        """run_chat with use_markdown=True uses rich Markdown."""
        from main import run_chat

        inputs = ["hello", "exit"]
        mock_session = mock.MagicMock()
        mock_session.prompt.side_effect = inputs
        with mock.patch("prompt_toolkit.PromptSession", return_value=mock_session):
            with mock.patch("execution.controller.Controller") as MockCtrl:
                mock_result = {"final": {"content": "# Hello\n\n- item"}}
                MockCtrl.return_value.run_problem.return_value = mock_result
                out = io.StringIO()
                with mock.patch("sys.stdout", out):
                    run_chat(session_key="test:md", use_markdown=True, workspace=self.workspace)
        text = out.getvalue()
        self.assertIn("Arceus", text)
        self.assertIn("Hello", text)

    def test_chat_uses_file_history(self):
        """run_chat uses PromptSession with FileHistory for up/down arrow history."""
        from main import run_chat
        from prompt_toolkit.history import FileHistory

        mock_session = mock.MagicMock()
        mock_session.prompt.side_effect = ["hi", "exit"]
        with mock.patch("prompt_toolkit.PromptSession", return_value=mock_session) as mock_ps:
            with mock.patch("execution.controller.Controller") as MockCtrl:
                MockCtrl.return_value.run_problem.return_value = {"final": {"content": "Hi"}}
                out = io.StringIO()
                with mock.patch("sys.stdout", out):
                    run_chat(session_key="test:hist", use_markdown=False, workspace=self.workspace)
        mock_ps.assert_called_once()
        call_kwargs = mock_ps.call_args[1]
        self.assertIn("history", call_kwargs)
        self.assertIsInstance(call_kwargs["history"], FileHistory)


if __name__ == "__main__":
    unittest.main()
