"""Consolidated tests for the core AgentLoop runtime and heartbeat."""

import asyncio
import shutil
import tempfile
import unittest
from pathlib import Path
from typing import Any, Dict, List

import sys

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from agents.tools.base import Tool
from agents.tools.registry import ToolRegistry
from execution.agent_loop import AgentLoop
from execution.controller import Controller
from heartbeat.service import HEARTBEAT_OK_TOKEN, _is_heartbeat_empty, HeartbeatService
from providers.adapter import ProviderAdapter, ProviderResponse, ToolCall
from providers.rule_based_provider import RuleBasedProvider


class DummyTool(Tool):
    """Simple deterministic tool for loop tests."""

    def __init__(self, name: str, output: str):
        self._name = name
        self._output = output

    @property
    def name(self) -> str:
        return self._name

    @property
    def description(self) -> str:
        return "dummy test tool"

    @property
    def parameters(self) -> dict[str, Any]:
        return {"type": "object", "properties": {"query": {"type": "string"}}}

    async def execute(self, **kwargs: Any) -> str:
        return self._output


class SequencedProvider(ProviderAdapter):
    """Stateful provider that returns pre-defined responses."""

    def __init__(self, responses: List[ProviderResponse]):
        self.responses = responses
        self.calls = 0

    async def complete(
        self,
        messages: List[Dict[str, Any]],
        tool_schemas: List[Dict[str, Any]],
        iteration: int,
        runtime_context: Dict[str, Any],
    ) -> ProviderResponse:
        idx = min(self.calls, len(self.responses) - 1)
        self.calls += 1
        return self.responses[idx]


class TestAgentLoop(unittest.TestCase):
    """Single-file loop-level coverage per workspace convention."""

    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.workspace = Path(self.temp_dir)
        for skill_name in ["problem-statement", "prioritization-advisor", "prd-development"]:
            skill_dir = self.workspace / "skills" / "workspace_skills" / skill_name
            skill_dir.mkdir(parents=True, exist_ok=True)
            (skill_dir / "SKILL.md").write_text(
                f"---\nname: {skill_name}\ndescription: test\n---\n\n# {skill_name}",
                encoding="utf-8",
            )

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_iteration_control_stops_on_done(self):
        provider = SequencedProvider(
            [ProviderResponse(content="final", done=True, confidence=0.9)]
        )
        loop = AgentLoop(self.workspace, provider=provider, max_iterations=4)
        result = loop.run_sync("Improve activation for new users")
        self.assertEqual(result["final"]["done"], True)
        self.assertEqual(len(result["traces"]), 1)

    def test_tool_call_handling_records_tool_results(self):
        registry = ToolRegistry()
        registry.register(DummyTool("web_search", "1. Source\n   https://example.com"))
        provider = SequencedProvider(
            [
                ProviderResponse(
                    content="Need data",
                    done=False,
                    tool_calls=[
                        ToolCall(
                            name="web_search",
                            arguments={"query": "onboarding dropoff"},
                            call_id="call-1",
                        )
                    ],
                ),
                ProviderResponse(content="Done", done=True),
            ]
        )
        loop = AgentLoop(self.workspace, provider=provider, registry=registry, max_iterations=3)
        result = loop.run_sync("Users are dropping in onboarding")
        self.assertGreaterEqual(len(result["traces"]), 2)
        first_trace = result["traces"][0]
        self.assertEqual(first_trace["tool_results"][0]["tool"], "web_search")
        self.assertGreaterEqual(len(result["web_evidence"]), 1)

    def test_web_learning_policy_requires_evidence_when_low_confidence(self):
        registry = ToolRegistry()
        registry.register(DummyTool("web_search", "1. Source\n   https://example.com/evidence"))
        loop = AgentLoop(
            self.workspace,
            provider=RuleBasedProvider(),
            registry=registry,
            max_iterations=3,
        )
        result = loop.run_sync("Need recommendation")
        self.assertGreaterEqual(len(result["web_evidence"]), 1)
        self.assertTrue(
            any(
                trace["decision"].get("requires_web_evidence", False)
                for trace in result["traces"]
            )
        )

    def test_reflection_and_memory_trace_writes(self):
        provider = SequencedProvider([ProviderResponse(content="final", done=True)])
        loop = AgentLoop(self.workspace, provider=provider, max_iterations=2)
        result = loop.run_sync("Users complain about latency")
        self.assertIn("reflection", result["traces"][0])
        persistent = result["memory_snapshot"]["persistent"]
        self.assertIn("traces", persistent)
        self.assertGreaterEqual(len(persistent["traces"]), 1)
        self.assertGreaterEqual(len(persistent["episodes"]), 1)

    def test_skill_gap_draft_generation_with_review_gate(self):
        # No skills in workspace for phase coverage.
        empty_workspace = Path(tempfile.mkdtemp())
        try:
            provider = SequencedProvider(
                [
                    ProviderResponse(content="continue", done=False),
                    ProviderResponse(content="continue", done=False),
                    ProviderResponse(content="done", done=True),
                ]
            )
            loop = AgentLoop(empty_workspace, provider=provider, max_iterations=3)
            result = loop.run_sync("Define a completely new product direction")
            self.assertGreaterEqual(len(result["drafted_skills"]), 1)
            for draft_path in result["drafted_skills"]:
                self.assertTrue(Path(draft_path).exists())
                content = Path(draft_path).read_text(encoding="utf-8")
                self.assertIn("review_required: true", content)
        finally:
            shutil.rmtree(empty_workspace, ignore_errors=True)


class TestHeartbeat(unittest.TestCase):
    """Heartbeat service tests (nanobot concept)."""

    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.workspace = Path(self.temp_dir)
        for skill_name in ["problem-statement", "heartbeat"]:
            skill_dir = self.workspace / "skills" / "workspace_skills" / skill_name
            skill_dir.mkdir(parents=True, exist_ok=True)
            (skill_dir / "SKILL.md").write_text(
                f"---\nname: {skill_name}\ndescription: test\n---\n\n# {skill_name}",
                encoding="utf-8",
            )

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_is_heartbeat_empty_none(self):
        self.assertTrue(_is_heartbeat_empty(None))

    def test_is_heartbeat_empty_blank(self):
        self.assertTrue(_is_heartbeat_empty(""))
        self.assertTrue(_is_heartbeat_empty("\n\n  \n"))

    def test_is_heartbeat_empty_headers_only(self):
        self.assertTrue(_is_heartbeat_empty("# Tasks\n## Section\n"))

    def test_is_heartbeat_empty_actionable_content(self):
        self.assertFalse(_is_heartbeat_empty("- [ ] Review backlog"))
        self.assertFalse(_is_heartbeat_empty("Check for new research"))

    def test_heartbeat_service_trigger_now_empty(self):
        async def on_hb(prompt: str) -> str:
            return HEARTBEAT_OK_TOKEN

        svc = HeartbeatService(self.workspace, on_heartbeat=on_hb, enabled=True)
        result = asyncio.run(svc.trigger_now())
        self.assertEqual(result, HEARTBEAT_OK_TOKEN)

    def test_controller_run_heartbeat_once(self):
        ctrl = Controller(self.workspace, provider=RuleBasedProvider())
        result = ctrl.run_heartbeat_once()
        self.assertIsNotNone(result)
        self.assertIsInstance(result, str)
        self.assertGreater(len(result), 0)


class TestCron(unittest.TestCase):
    """Cron service and tool tests (nanobot concept)."""

    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.workspace = Path(self.temp_dir)
        (self.workspace / "skills" / "workspace_skills" / "cron").mkdir(
            parents=True, exist_ok=True
        )
        (self.workspace / "skills" / "workspace_skills" / "cron" / "SKILL.md").write_text(
            "---\nname: cron\ndescription: test\n---\n\n# cron",
            encoding="utf-8",
        )

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_cron_service_add_list_remove(self):
        from cron.service import CronService
        from cron.types import CronSchedule

        store_path = self.workspace / ".arceus" / "cron.json"
        svc = CronService(store_path=store_path)
        schedule = CronSchedule(kind="every", every_ms=60_000)
        job = svc.add_job(
            name="test job",
            schedule=schedule,
            message="Remind me",
        )
        self.assertIsNotNone(job.id)
        self.assertEqual(job.name, "test job")
        self.assertEqual(job.schedule.kind, "every")

        jobs = svc.list_jobs()
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0].id, job.id)

        removed = svc.remove_job(job.id)
        self.assertTrue(removed)
        self.assertEqual(len(svc.list_jobs()), 0)

    def test_cron_tool_via_controller(self):
        ctrl = Controller(self.workspace)

        async def run():
            add_result = await ctrl.loop.registry.execute(
                "cron",
                {"action": "add", "message": "Break time!", "every_seconds": 1200},
            )
            self.assertIn("Created job", add_result)
            list_result = await ctrl.loop.registry.execute("cron", {"action": "list"})
            self.assertIn("Break time!", list_result)
            self.assertIn("id:", list_result)

        asyncio.run(run())


class TestSession(unittest.TestCase):
    """Session manager tests (from nanobot)."""

    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.workspace = Path(self.temp_dir)
        for skill_name in ["problem-statement"]:
            skill_dir = self.workspace / "skills" / "workspace_skills" / skill_name
            skill_dir.mkdir(parents=True, exist_ok=True)
            (skill_dir / "SKILL.md").write_text(
                f"---\nname: {skill_name}\ndescription: test\n---\n\n# {skill_name}",
                encoding="utf-8",
            )

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_session_manager_persists_messages(self):
        from session.manager import SessionManager

        mgr = SessionManager(self.workspace)
        session = mgr.get_or_create("console:test1")
        session.add_message("user", "Hello")
        session.add_message("assistant", "Hi there")
        mgr.save(session)

        mgr.invalidate("console:test1")
        loaded = mgr.get_or_create("console:test1")
        self.assertEqual(len(loaded.messages), 2)
        self.assertEqual(loaded.messages[0]["content"], "Hello")
        self.assertEqual(loaded.messages[1]["content"], "Hi there")

    def test_agent_loop_with_session_key_persists(self):
        provider = SequencedProvider(
            [ProviderResponse(content="Got it.", done=True, confidence=0.9)]
        )
        loop = AgentLoop(self.workspace, provider=provider, max_iterations=2)
        loop.run_sync("First message", session_key="console:multi")
        result = loop.run_sync("Second message", session_key="console:multi")
        self.assertIn("Got it", result["final"]["content"])
        session = loop.session_manager.get_or_create("console:multi")
        self.assertGreaterEqual(len(session.messages), 2)


if __name__ == "__main__":
    unittest.main()
