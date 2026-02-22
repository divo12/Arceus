"""Core iterative runtime: context -> provider -> tools -> iterate."""

import asyncio
import json
from contextlib import AsyncExitStack
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional
from uuid import uuid4

from agents.context_builder import ContextBuilder
from agents.prompts import PromptLoader
from agents.skills import SkillsLoader
from agents.tools.filesystem import EditFileTool, ListDirTool, ReadFileTool, WriteFileTool
from agents.tools.mcp import connect_mcp_servers
from agents.tools.registry import ToolRegistry
from agents.tools.shell import ExecTool
from agents.tools.spawn import SpawnTool
from agents.tools.web import SearXSearchTool, WebFetchTool, WebSearchTool
from execution.subagent_manager import SubagentManager
from cognition.cognitive_loop import CognitiveLoop
from cognition.memory.memory_manager import MemoryManager
from cognition.memory.problem_memory import ProblemMemory
from config import Config, load_config
from providers.adapter import ProviderAdapter, ProviderResponse, ToolCall
from providers.azure_openai_provider import AzureOpenAIProvider
from session.manager import SessionManager


def _build_provider(config: Config) -> ProviderAdapter:
    """Build provider from config; config overrides env when both exist."""
    from settings import Settings
    api_key = config.providers.azure.api_key or Settings.AZURE_OPENAI_API_KEY or ""
    endpoint = config.providers.azure.endpoint or Settings.AZURE_OPENAI_ENDPOINT or ""
    if not api_key or not endpoint:
        raise ValueError(
            "Azure OpenAI credentials required. Set AZURE_OPENAI_API_KEY and AZURE_OPENAI_ENDPOINT "
            "in .env or in .arceus/config.json under providers.azure"
        )
    return AzureOpenAIProvider(
        model=config.providers.azure.deployment,
        temperature=config.agents.defaults.temperature,
        api_key=api_key,
        endpoint=endpoint,
    )


class AgentLoop:
    """Nanobot-inspired runtime loop for PM-oriented autonomous execution."""

    def __init__(
        self,
        workspace: Path,
        provider: Optional[ProviderAdapter] = None,
        registry: Optional[ToolRegistry] = None,
        max_iterations: Optional[int] = None,
        config: Optional[Config] = None,
    ):
        self.workspace = Path(workspace).expanduser().resolve()
        self.config = config or load_config(workspace=self.workspace)
        self.context_builder = ContextBuilder(self.workspace)
        self.prompts = PromptLoader(self.workspace)
        self.skills = SkillsLoader(self.workspace)
        self.cognition = CognitiveLoop(self.workspace)
        self.memory = MemoryManager(self.workspace)
        self.problem_memory = ProblemMemory(self.workspace)
        self.provider = provider or _build_provider(self.config)
        self.subagent_manager = SubagentManager(
            provider=self.provider,
            workspace=self.workspace,
            config=self.config,
        )
        self.registry = registry or self._build_default_registry()
        self.max_iterations = max_iterations or self.config.agents.defaults.max_iterations
        self.session_manager = SessionManager(self.workspace)

    def _build_default_registry(self) -> ToolRegistry:
        registry = ToolRegistry()
        allowed_dir = self.workspace
        registry.register(ReadFileTool(allowed_dir))
        registry.register(WriteFileTool(allowed_dir))
        registry.register(EditFileTool(allowed_dir))
        registry.register(ListDirTool(allowed_dir))
        restrict = self.config.tools.restrict_to_workspace
        registry.register(
            ExecTool(
                working_dir=str(self.workspace),
                restrict_to_workspace=restrict,
                timeout=self.config.tools.exec.timeout,
            )
        )
        web_key = self.config.get_web_search_api_key()
        registry.register(
            WebSearchTool(api_key=web_key or None, max_results=self.config.tools.web.max_results)
        )
        registry.register(SearXSearchTool(max_results=self.config.tools.web.max_results))
        registry.register(WebFetchTool())
        registry.register(SpawnTool(self.subagent_manager))
        return registry

    def _mcp_servers_dict(self) -> Dict[str, Any]:
        """Convert config mcp_servers to dict for connect_mcp_servers."""
        import os

        def expand_env(env: dict) -> dict:
            out = {}
            for k, v in (env or {}).items():
                s = str(v)
                s = os.path.expanduser(s)
                s = os.path.expandvars(s)
                out[k] = s
            return out

        out = {}
        for name, cfg in self.config.tools.mcp_servers.items():
            env = expand_env(cfg.env)
            command, args = cfg.command, cfg.args or []
            # Web Search MCP: inject workspace-aware defaults if not set
            if name == "web_search":
                if "NPM_CONFIG_CACHE" not in env:
                    env.setdefault(
                        "NPM_CONFIG_CACHE",
                        str((self.workspace / ".arceus" / ".npm-cache").resolve()),
                    )
                if "PLAYWRIGHT_BROWSERS_PATH" not in env:
                    env.setdefault(
                        "PLAYWRIGHT_BROWSERS_PATH",
                        str((Path.home() / "mcp-servers" / "web-search-mcp" / ".playwright").resolve()),
                    )
                # Use local build: WEB_SEARCH_MCP_PATH env, or expand args[0] if path
                mcp_path = os.environ.get("WEB_SEARCH_MCP_PATH", "").strip()
                if mcp_path:
                    resolved = Path(mcp_path).expanduser().resolve()
                    if resolved.exists():
                        command, args = "node", [str(resolved)]
                elif args:
                    # Expand $HOME in first arg (path to dist/index.js)
                    expanded = os.path.expanduser(os.path.expandvars(args[0]))
                    if Path(expanded).exists():
                        command, args = "node", [expanded]
            out[name] = type("Cfg", (), {
                "command": command,
                "args": args,
                "env": env,
                "url": cfg.url or "",
            })()
        return out

    async def run(
        self,
        problem_description: str,
        context: Optional[Dict[str, Any]] = None,
        max_iterations: Optional[int] = None,
        session_key: Optional[str] = None,
        stream_callback: Optional[Any] = None,
    ) -> Dict[str, Any]:
        run_id = str(uuid4())
        context = context or {}
        mcp_added: List[str] = []

        async with AsyncExitStack() as stack:
            if self.config.tools.mcp_servers:
                mcp_dict = self._mcp_servers_dict()
                await connect_mcp_servers(mcp_dict, self.registry, stack)
                mcp_added = [n for n in self.registry.tool_names if n.startswith("mcp_")]

            iterations = max_iterations or self.max_iterations
            available_skills = [s["name"] for s in self.skills.list_skills(filter_unavailable=False)]
            available_prompts = [p["name"] for p in self.prompts.list_prompts()]

            history: List[Dict[str, Any]] = []
            if session_key:
                session = self.session_manager.get_or_create(session_key)
                history = session.get_history()

            messages = self.context_builder.build_messages(
                history=history,
                current_message=problem_description,
                skill_names=None,
                prompt_names=None,
            )

            self.problem_memory.record_initial(problem_description, run_id=run_id)

            web_evidence: List[Dict[str, str]] = []
            traces: List[Dict[str, Any]] = []
            final_response = ProviderResponse(content="", done=False)
            skill_gaps_seen: Dict[str, int] = {}
            prev_feedback: Optional[Dict[str, Any]] = None

            for iteration in range(1, iterations + 1):
                # Integrate completed subagent results (feedback, learnings, new_angle)
                completed_subagents = self.subagent_manager.get_completed_results()
                if completed_subagents:
                    prev_feedback = self._merge_subagent_results(
                        prev_feedback or {},
                        completed_subagents,
                        problem_description=problem_description,
                        run_id=run_id,
                    )
                if prev_feedback:
                    feedback_msg = self._format_feedback_message(prev_feedback)
                    messages.append({"role": "user", "content": feedback_msg})

                cognition = self.cognition.run(
                    problem_description=problem_description,
                    context=context,
                    available_skills=available_skills,
                    available_prompts=available_prompts,
                    run_id=run_id,
                    iteration=iteration,
                    web_evidence=web_evidence,
                    feedback=prev_feedback,
                )

                missing_phases = [
                    phase["phase"]
                    for phase in cognition.get("plan", {}).get("phases", [])
                    if not phase.get("skills")
                ]
                for phase in missing_phases:
                    skill_gaps_seen[phase] = skill_gaps_seen.get(phase, 0) + 1

                runtime_ctx: Dict[str, Any] = {
                    "problem": problem_description,
                    "run_id": run_id,
                    "cognition": cognition,
                    "require_web_evidence": cognition.get("decision", {}).get(
                        "requires_web_evidence", False
                    ),
                    "web_evidence": web_evidence,
                    "feedback": prev_feedback,
                }
                if stream_callback is not None:
                    runtime_ctx["stream_callback"] = stream_callback
                response = await self.provider.complete(
                    messages=messages,
                    tool_schemas=self.registry.get_definitions(),
                    iteration=iteration,
                    runtime_context=runtime_ctx,
                )
                final_response = response

                tool_results: List[Dict[str, Any]] = []
                self.context_builder.add_assistant_message(
                    messages,
                    content=response.content,
                    tool_calls=[self._tool_call_to_message(tc) for tc in response.tool_calls]
                    if response.tool_calls
                    else None,
                )

                if response.tool_calls:
                    for call in response.tool_calls:
                        result = await self.registry.execute(call.name, call.arguments)
                        tool_results.append(
                            {"tool": call.name, "arguments": call.arguments, "result": result}
                        )
                        self.context_builder.add_tool_result(
                            messages, call.call_id, call.name, result
                        )
                        web_evidence.extend(self._extract_web_evidence(call.name, result))

                trace = {
                    "run_id": run_id,
                    "iteration": iteration,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "response": {
                        "content": response.content,
                        "confidence": response.confidence,
                        "done": response.done,
                        "rationale": response.rationale,
                    },
                    "tool_results": tool_results,
                    "decision": cognition.get("decision", {}),
                    "reflection": cognition.get("reflection", {}),
                }
                traces.append(trace)
                self.memory.record_trace(trace)

                if response.tool_calls:
                    prev_feedback = self._compute_feedback(
                        tool_results=tool_results,
                        web_evidence=web_evidence,
                    )

                req_web = cognition.get("decision", {}).get("requires_web_evidence")
                if response.done and (
                    not req_web or web_evidence or response.confidence >= 0.85
                ):
                    break

            drafted_skills = self._draft_skill_gaps(
                problem_description=problem_description,
                skill_gaps_seen=skill_gaps_seen,
                traces=traces,
            )

            run_summary = {
                "run_id": run_id,
                "problem": problem_description,
                "iterations": len(traces),
                "web_evidence_count": len(web_evidence),
                "drafted_skills": drafted_skills,
                "final_response": {
                    "content": final_response.content,
                    "confidence": final_response.confidence,
                    "done": final_response.done,
                },
            }
            self.memory.record_run_summary(run_summary)

            if session_key:
                session = self.session_manager.get_or_create(session_key)
                new_msgs = messages[1 + len(history) :]
                for msg in new_msgs:
                    extra = {k: msg[k] for k in ("tool_calls", "tool_call_id", "name") if k in msg}
                    session.add_message(msg["role"], msg.get("content", ""), **extra)
                self.session_manager.save(session)

            for name in mcp_added:
                self.registry.unregister(name)

            return {
                "run_id": run_id,
                "messages": messages,
                "traces": traces,
                "web_evidence": web_evidence,
                "drafted_skills": drafted_skills,
                "final": run_summary["final_response"],
                "memory_snapshot": self.memory.get_memory_snapshot(),
            }

    def _merge_subagent_results(
        self,
        prev_feedback: Dict[str, Any],
        completed_subagents: List[Dict[str, Any]],
        problem_description: str = "",
        run_id: str = "",
    ) -> Dict[str, Any]:
        """Merge completed subagent results (feedback, learnings, new_angle) into prev_feedback."""
        out = dict(prev_feedback)
        subagent_results = list(out.get("subagent_results", []))
        new_angles = list(out.get("new_angles", []))
        learnings = list(out.get("learnings", []))

        for sr in completed_subagents:
            label = sr.get("label", "subagent")
            subagent_results.append({
                "task": sr.get("task", ""),
                "result": sr.get("summary", sr.get("raw", "")),
                "feedback": sr.get("feedback", ""),
                "learnings": sr.get("learnings", ""),
                "new_angle": sr.get("new_angle", ""),
            })
            if sr.get("new_angle"):
                new_angles.append(f"[{label}] {sr['new_angle']}")
                if problem_description:
                    self.problem_memory.append_improvement(
                        problem_description, sr["new_angle"], source="subagent", run_id=run_id or None
                    )
            if sr.get("learnings"):
                learnings.append(f"[{label}] {sr['learnings']}")
                if problem_description:
                    self.problem_memory.append_improvement(
                        problem_description, sr["learnings"], source="subagent_learnings", run_id=run_id or None
                    )

        parts: List[str] = []
        if out.get("web_evidence_count", 0):
            parts.append(f"Gathered {out['web_evidence_count']} web evidence item(s).")
        for sr in subagent_results:
            fb = sr.get("feedback") or sr.get("result", "")
            if fb:
                parts.append(f"Subagent ({sr.get('task', '')[:40]}): {str(fb)[:300]}...")
        if new_angles:
            parts.append("New angles to consider: " + "; ".join(new_angles[:3]))
        if learnings:
            parts.append("Learnings: " + "; ".join(learnings[:2]))
        if out.get("summary"):
            parts.append(out["summary"])
        summary = " ".join(parts) if parts else "No new feedback from tools."

        out["subagent_results"] = subagent_results
        out["new_angles"] = new_angles
        out["learnings"] = learnings
        out["summary"] = summary
        return out

    def _compute_feedback(
        self,
        tool_results: List[Dict[str, Any]],
        web_evidence: List[Dict[str, str]],
    ) -> Dict[str, Any]:
        """Compute feedback from tool results and web evidence for the next iteration."""
        subagent_results: List[Dict[str, str]] = []
        tool_summaries: List[str] = []
        for tr in tool_results:
            name = tr.get("tool", "")
            result = str(tr.get("result", ""))
            if name == "spawn":
                args = tr.get("arguments", {})
                task = args.get("task", "subagent task")[:60]
                subagent_results.append({"task": task, "result": result[:1000]})
            elif result and len(result) < 200:
                tool_summaries.append(f"{name}: {result[:150]}")
            elif result:
                tool_summaries.append(f"{name}: {result[:150]}...")

        parts: List[str] = []
        if web_evidence:
            parts.append(f"Gathered {len(web_evidence)} web evidence item(s).")
        for sr in subagent_results:
            parts.append(f"Subagent ({sr['task']}): {sr['result'][:300]}...")
        if tool_summaries:
            parts.append("Tool outputs: " + "; ".join(tool_summaries[:3]))
        summary = " ".join(parts) if parts else "No new feedback from tools."

        return {
            "web_evidence_count": len(web_evidence),
            "subagent_results": subagent_results,
            "new_angles": [],
            "learnings": [],
            "summary": summary,
        }

    def _format_feedback_message(self, feedback: Dict[str, Any]) -> str:
        """Format feedback as a user message for the next iteration."""
        parts = [feedback.get("summary", "")]
        new_angles = feedback.get("new_angles", [])
        if new_angles:
            parts.append("\n\nNew angles to validate/solve: " + "; ".join(new_angles))
        learnings = feedback.get("learnings", [])
        if learnings:
            parts.append("\n\nLearnings to incorporate: " + "; ".join(learnings[:3]))
        body = "\n".join(parts).strip()
        return f"[Feedback from last iteration]\n\n{body}\n\nConsider this when refining your plan. Validate new angles before solving."

    @staticmethod
    def _tool_call_to_message(call: ToolCall) -> Dict[str, Any]:
        return {
            "id": call.call_id,
            "type": "function",
            "function": {"name": call.name, "arguments": json.dumps(call.arguments)},
        }

    @staticmethod
    def _extract_web_evidence(tool_name: str, result: str) -> List[Dict[str, str]]:
        if tool_name not in {"web_search", "web_fetch"} and not tool_name.startswith("mcp_web_search_"):
            return []
        if tool_name.startswith("mcp_web_search_"):
            return [{"source": "web_search_mcp", "summary": (result or "")[:500]}]
        if tool_name == "web_fetch":
            try:
                payload = json.loads(result)
                source = payload.get("finalUrl") or payload.get("url")
                if source:
                    return [{"source": source, "summary": payload.get("text", "")[:500]}]
            except json.JSONDecodeError:
                return []
            return []
        evidence = []
        for line in result.splitlines():
            stripped = line.strip()
            if stripped.startswith("http://") or stripped.startswith("https://"):
                evidence.append({"source": stripped, "summary": "web search result"})
            if "   http" in stripped:
                parts = stripped.split()
                for part in parts:
                    if part.startswith("http://") or part.startswith("https://"):
                        evidence.append({"source": part, "summary": "web search result"})
        return evidence

    def _draft_skill_gaps(
        self,
        problem_description: str,
        skill_gaps_seen: Dict[str, int],
        traces: List[Dict[str, Any]],
    ) -> List[str]:
        drafted_paths: List[str] = []
        for phase, count in skill_gaps_seen.items():
            if count < 2:
                continue
            skill_name = f"{phase}-support-skill"
            path = self.skills.create_skill_draft(
                skill_name=skill_name,
                problem=problem_description,
                rationale=f"Missing capability in phase '{phase}' seen {count} iterations.",
                evidence=traces[-2:],
            )
            drafted_paths.append(str(path))
        return drafted_paths

    def run_sync(
        self,
        problem_description: str,
        context: Optional[Dict[str, Any]] = None,
        max_iterations: Optional[int] = None,
        session_key: Optional[str] = None,
        stream_callback: Optional[Any] = None,
    ) -> Dict[str, Any]:
        """Synchronous wrapper used by scripts/tests."""
        return asyncio.run(
            self.run(
                problem_description,
                context,
                max_iterations,
                session_key,
                stream_callback,
            )
        )
