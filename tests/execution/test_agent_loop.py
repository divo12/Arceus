"""Consolidated tests for the core AgentLoop runtime."""

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


if __name__ == "__main__":
    unittest.main()
