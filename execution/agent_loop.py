"""Core iterative runtime: context -> provider -> tools -> iterate."""

import asyncio
import json
from contextlib import AsyncExitStack
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional
from uuid import uuid4

from agents.context_builder import ContextBuilder
from agents.skills import SkillsLoader
from agents.tools.filesystem import EditFileTool, ListDirTool, ReadFileTool, WriteFileTool
from agents.tools.mcp import connect_mcp_servers
from agents.tools.registry import ToolRegistry
from agents.tools.shell import ExecTool
from agents.tools.spawn import SpawnTool
from agents.tools.web import WebFetchTool, WebSearchTool
from execution.subagent_manager import SubagentManager
from cognition.cognitive_loop import CognitiveLoop
from cognition.memory.memory_manager import MemoryManager
from cognition.memory.problem_memory import ProblemMemory
from config import Config, load_config
from artifacts.renderer import (
    render_decision_record,
    render_evidence_brief,
    render_options_set,
)
from observability.events import track_event
from packets.service import write_packet_bundle
from packets.types import DecisionItem, SourceItem
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

    PM_SCOPE_KEYWORDS = (
        "product manager",
        "pm",
        "cursor for pms",
        "what to build next",
        "prioritization",
        "roadmap",
        "discovery",
        "decision record",
        "evidence brief",
        "stakeholder",
        "prd",
    )

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
        gkey, gcx = self.config.get_google_search_config()
        registry.register(
            WebSearchTool(
                google_api_key=gkey or None,
                google_search_engine_id=gcx or None,
                max_results=self.config.tools.web.max_results,
            )
        )
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
        skill_names: Optional[List[str]] = None,
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

            history: List[Dict[str, Any]] = []
            if session_key:
                session = self.session_manager.get_or_create(session_key)
                history = session.get_history()

            messages = self.context_builder.build_messages(
                history=history,
                current_message=problem_description,
                skill_names=skill_names,
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

    def _pm_state_path(self, loop_id: str) -> Path:
        state_dir = self.workspace / "data" / "state" / "workflows"
        state_dir.mkdir(parents=True, exist_ok=True)
        return state_dir / f"{loop_id}.json"

    def _load_pm_state(self, loop_id: str) -> Dict[str, Any]:
        path = self._pm_state_path(loop_id)
        if not path.exists():
            return {
                "loop_id": loop_id,
                "current_cycle": 0,
                "problem_queue": [],
                "processed_problems": [],
                "last_feedback": {},
                "last_decision": {},
                "cycle_summaries": [],
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return {
                "loop_id": loop_id,
                "current_cycle": 0,
                "problem_queue": [],
                "processed_problems": [],
                "last_feedback": {},
                "last_decision": {},
                "cycle_summaries": [],
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }

    def _save_pm_state(self, state: Dict[str, Any]) -> None:
        loop_id = str(state.get("loop_id", "pm_loop_default"))
        path = self._pm_state_path(loop_id)
        state["updated_at"] = datetime.now(timezone.utc).isoformat()
        path.write_text(json.dumps(state, indent=2), encoding="utf-8")

    def _append_new_ideas_update(
        self,
        *,
        ideas_path: Path,
        content: str,
        content_before: str = "",
    ) -> None:
        """Append-only writer for new_ideas.md (never overwrite prior sections)."""
        timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        section = f"\n\n## Update — {timestamp}\n\n{content.strip()}\n"
        if content_before.strip():
            base = content_before.rstrip()
            ideas_path.write_text(base + section, encoding="utf-8")
            return
        if ideas_path.exists() and ideas_path.stat().st_size > 0:
            existing = ideas_path.read_text(encoding="utf-8")
            ideas_path.write_text(existing.rstrip() + section, encoding="utf-8")
            return
        header = f"# New Ideas Log\n\nStarted: {timestamp}\n"
        ideas_path.write_text(header + section, encoding="utf-8")

    def _render_new_ideas_cycle_markdown(
        self,
        *,
        cycle: int,
        problem: str,
        output: Dict[str, Any],
    ) -> str:
        recs = output.get("ranked_recommendations", [])
        top = recs[0] if recs else {}
        decision_record = output.get("decision_record", "")
        exec_plan = output.get("execution_plan", {})
        feedback = output.get("feedback", "")
        packet_ref = output.get("packet_ref", "")
        lines = [
            f"### PM Loop Cycle {cycle}",
            "",
            f"**Problem:** {problem}",
            "",
            "#### Recommendation",
            f"- Priority: {top.get('priority', 1)}",
            f"- Confidence: {top.get('confidence', 0.5)}",
            f"- Rationale: {top.get('rationale', '')}",
            "",
            "#### Execution Plan Summary",
            f"{exec_plan.get('summary', '')}",
            "",
            "#### Feedback Applied",
            feedback or "_No feedback_",
            "",
            "#### Packet Ref",
            f"- `{packet_ref}`" if packet_ref else "- _No packet generated_",
            "",
            "#### Decision Record Snapshot",
            "```markdown",
            (decision_record[:1200] + ("..." if len(decision_record) > 1200 else "")),
            "```",
        ]
        return "\n".join(lines).strip()

    async def _simulate_feedback(
        self,
        *,
        cycle_problem: str,
        final_content: str,
        run_id: str,
    ) -> str:
        """Generate synthetic user feedback using one extra LLM call."""
        messages = [
            {
                "role": "system",
                "content": (
                    "You are a critical but constructive PM stakeholder. "
                    "Given an idea and a recommendation, provide concise user feedback "
                    "that includes: what resonates, what is missing, and one new problem "
                    "to investigate next."
                ),
            },
            {
                "role": "user",
                "content": (
                    f"Idea/problem:\n{cycle_problem}\n\n"
                    f"Recommendation output:\n{final_content}\n\n"
                    "Return plain text feedback in 4-8 bullet points."
                ),
            },
        ]
        resp = await self.provider.complete(
            messages=messages,
            tool_schemas=[],
            iteration=1,
            runtime_context={"mode": "pm_feedback_simulation", "run_id": run_id},
        )
        feedback = (resp.content or "").strip()
        if not feedback:
            feedback = (
                "- Recommendation is directionally useful.\n"
                "- Need stronger confidence and metric guardrails.\n"
                "- Missing edge-case handling details.\n"
                "- New problem to investigate: post-onboarding retention drop."
            )
        track_event(
            workspace=self.workspace,
            name="pm_feedback_generated",
            properties={"run_id": run_id},
        )
        return feedback

    def _derive_next_problems(
        self,
        *,
        current_problem: str,
        feedback: str,
        processed: List[str],
        max_new: int = 2,
    ) -> List[str]:
        """Derive next-problem candidates from feedback with simple dedup."""
        candidates: List[str] = []
        for line in (feedback or "").splitlines():
            text = line.strip(" -\t")
            if not text:
                continue
            if "new problem" in text.lower() or "investigate" in text.lower():
                candidates.append(text)
        if not candidates and feedback.strip():
            candidates.append(f"Investigate follow-up from feedback: {feedback[:160]}")
        deduped: List[str] = []
        seen = set(x.strip().lower() for x in processed + [current_problem])
        for c in candidates:
            key = c.strip().lower()
            if not self._is_pm_scope_problem(c):
                continue
            if key in seen:
                continue
            seen.add(key)
            deduped.append(c)
            if len(deduped) >= max_new:
                break
        if not deduped:
            deduped.append(self._fallback_pm_problem(current_problem))
        return deduped

    def _is_pm_scope_problem(self, text: str) -> bool:
        low = (text or "").lower()
        return any(k in low for k in self.PM_SCOPE_KEYWORDS)

    def _fallback_pm_problem(self, current_problem: str) -> str:
        return (
            "For Cursor for Product Managers, what should we build next to improve "
            "problem discovery, prioritization quality, and decision traceability "
            f"given this context: {current_problem[:140]}"
        )

    def _build_pm_cycle_prompt(
        self,
        *,
        problem: str,
        previous_feedback: str = "",
        recent_cycle_summaries: Optional[List[str]] = None,
    ) -> str:
        feedback_block = (
            f"\n\nPrevious user feedback to incorporate:\n{previous_feedback}\n"
            if previous_feedback.strip()
            else ""
        )
        recent = [x.strip() for x in (recent_cycle_summaries or []) if str(x).strip()]
        summary_block = ""
        if recent:
            joined = "\n".join(f"- {item}" for item in recent)
            summary_block = f"\n\nRecent cycle summaries (N-2 and N-1):\n{joined}\n"
        return (
            "PM Agent mode: Given the problem below, decide what to build next.\n"
            "Stay in scope: Cursor for Product Managers. Avoid drifting into generic "
            "infra/debug topics unless they directly impact PM user outcomes.\n"
            "Follow this sequence explicitly: evidence-brief -> options-set-generator -> decision-record.\n"
            "Spawn focused subagents for weak/unknown areas.\n"
            "Output in sections: Ranked recommendations, Decision record summary, Execution plan, Metrics.\n"
            f"\nProblem:\n{problem}{feedback_block}{summary_block}"
        )

    def _build_cycle_summary(
        self,
        *,
        cycle: int,
        problem: str,
        output: Dict[str, Any],
    ) -> str:
        top = (output.get("ranked_recommendations") or [{}])[0]
        rationale = str(top.get("rationale", "")).replace("\n", " ").strip()
        feedback = str(output.get("feedback", "")).replace("\n", " ").strip()
        rationale_short = rationale[:220] + ("..." if len(rationale) > 220 else "")
        feedback_short = feedback[:160] + ("..." if len(feedback) > 160 else "")
        return (
            f"Cycle {cycle}: Problem='{problem[:120]}', "
            f"Recommendation='{rationale_short}', "
            f"Feedback='{feedback_short or 'none'}'"
        )

    def _build_pm_output(
        self,
        *,
        problem: str,
        run_result: Dict[str, Any],
        feedback: str,
        loop_id: str,
        cycle: int,
    ) -> Dict[str, Any]:
        final_content = run_result.get("final", {}).get("content", "")
        confidence = float(run_result.get("final", {}).get("confidence", 0.5) or 0.5)
        rec = {
            "title": "Primary recommendation",
            "rationale": final_content[:600] if final_content else "No rationale generated.",
            "confidence": confidence,
            "priority": 1,
        }
        decision_payload = {
            "title": f"Cycle {cycle} decision",
            "context": problem,
            "decision": final_content[:500] if final_content else "No decision content.",
            "alternatives": [{"option": "Keep current approach", "reason": "Baseline"}],
            "rationale": "Derived from PM cycle synthesis.",
            "metrics": {"primary": "Outcome metric to be validated", "guardrails": "No regressions"},
            "revisit_triggers": ["If outcome metric does not improve within target window"],
        }
        decision_record = render_decision_record(decision_payload)
        evidence_brief = render_evidence_brief({"topic": problem, "recommendation": final_content})
        options_set = render_options_set({"title": f"Options for {problem}", "recommendation": "Use ranked #1"})
        decision_id = f"DEC-{cycle:03d}"
        packet_dir = write_packet_bundle(
            workspace=self.workspace,
            packet_id=f"{loop_id}",
            decisions=[
                DecisionItem(
                    id=decision_id,
                    title=f"Cycle {cycle} recommendation",
                    decidedAt=datetime.now(timezone.utc).isoformat(),
                    owner="pm-agent",
                    evidenceIds=[],
                )
            ],
            sources=[SourceItem(id=f"SRC-{cycle:03d}", type="link", uri="https://arceus.local/pm-loop")],
            exported_by="pm-agent",
            export_scope="team",
            export_reason="pm_loop_cycle",
        )
        packet_ref = str(packet_dir.relative_to(self.workspace))
        return {
            "ranked_recommendations": [rec],
            "decision_record": decision_record,
            "execution_plan": {
                "summary": final_content[:800],
                "evidence_brief": evidence_brief,
                "options_set": options_set,
            },
            "feedback": feedback,
            "packet_ref": packet_ref,
        }

    async def run_pm_loop(
        self,
        *,
        idea: str,
        loop_id: str = "pm_loop_default",
        max_cycles: int = 1,
        run_forever: bool = False,
        simulate_feedback: bool = True,
        cooldown_seconds: int = 0,
        session_key: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        PM continuous loop mode.

        Runs one or more PM cycles and persists resumable state under data/state/workflows.
        """
        pm_cfg = self.config.agents.pm_loop
        if pm_cfg.kill_switch or not pm_cfg.enabled:
            return {
                "loop_id": loop_id,
                "cycles_executed": 0,
                "state": {"disabled": True, "reason": "pm_loop disabled or kill_switch set"},
                "outputs": [],
                "report_path": "",
            }

        run_forever = bool(run_forever or pm_cfg.single_run_infinite)
        max_cycles = max(1, min(max_cycles, max(1, int(pm_cfg.max_cycles_per_run))))
        simulate_feedback = bool(simulate_feedback and pm_cfg.simulate_feedback)
        cooldown_seconds = max(cooldown_seconds, int(pm_cfg.cooldown_seconds))

        state = self._load_pm_state(loop_id)
        state.setdefault("cycle_summaries", [])
        if not state.get("problem_queue"):
            state["problem_queue"] = [idea]
        track_event(
            workspace=self.workspace,
            name="pm_workflow_started",
            properties={"loop_id": loop_id, "max_cycles": max_cycles},
        )
        cycle_outputs: List[Dict[str, Any]] = []

        cycles_done = 0
        while run_forever or (cycles_done < max_cycles):
            if not state.get("problem_queue"):
                if not run_forever:
                    break
                # Keep loop alive when queue empties in infinite mode.
                follow_up = ""
                last_feedback = str(state.get("last_feedback", "")).strip()
                if last_feedback:
                    follow_up = f"Investigate follow-up from feedback: {last_feedback[:200]}"
                elif state.get("processed_problems"):
                    follow_up = str(state["processed_problems"][-1])
                else:
                    follow_up = idea
                state["problem_queue"] = [follow_up]

            cycle_problem = state["problem_queue"].pop(0)
            run_prompt = self._build_pm_cycle_prompt(
                problem=cycle_problem,
                previous_feedback=str(state.get("last_feedback", "")),
                recent_cycle_summaries=list(state.get("cycle_summaries", [])),
            )
            # PM loop runs in append-only mode for ideas output:
            # disable direct write/edit tools during the model turn.
            disabled_tool_names: List[str] = []
            for tname in ("write_file", "edit_file"):
                if tname in self.registry.tool_names:
                    self.registry.unregister(tname)
                    disabled_tool_names.append(tname)
            try:
                run_result = await self.run(
                    problem_description=run_prompt,
                    session_key=session_key,
                    skill_names=["evidence-brief", "options-set-generator", "decision-record"],
                )
            finally:
                # Restore write/edit tools for normal runtime behavior.
                if "write_file" in disabled_tool_names:
                    self.registry.register(WriteFileTool(self.workspace))
                if "edit_file" in disabled_tool_names:
                    self.registry.register(EditFileTool(self.workspace))
            run_id = str(run_result.get("run_id", ""))
            final_content = str(run_result.get("final", {}).get("content", ""))
            if simulate_feedback:
                feedback = await self._simulate_feedback(
                    cycle_problem=cycle_problem,
                    final_content=final_content,
                    run_id=run_id,
                )
            else:
                feedback = ""

            output = self._build_pm_output(
                problem=cycle_problem,
                run_result=run_result,
                feedback=feedback,
                loop_id=loop_id,
                cycle=int(state.get("current_cycle", 0)) + 1,
            )
            cycle_outputs.append(output)

            # Append-only write to new_ideas.md
            ideas_path = self.workspace / "new_ideas.md"
            before = ideas_path.read_text(encoding="utf-8") if ideas_path.exists() else ""
            cycle_md = self._render_new_ideas_cycle_markdown(
                cycle=int(state.get("current_cycle", 0)) + 1,
                problem=cycle_problem,
                output=output,
            )
            self._append_new_ideas_update(
                ideas_path=ideas_path,
                content=cycle_md,
                content_before=before,
            )

            next_problems = self._derive_next_problems(
                current_problem=cycle_problem,
                feedback=feedback,
                processed=list(state.get("processed_problems", [])),
            )
            for p in next_problems:
                if not pm_cfg.deduplicate_problems or p not in state["problem_queue"]:
                    state["problem_queue"].append(p)
                    track_event(
                        workspace=self.workspace,
                        name="pm_next_problem_derived",
                        properties={"loop_id": loop_id, "problem": p[:200]},
                    )

            state["current_cycle"] = int(state.get("current_cycle", 0)) + 1
            state.setdefault("processed_problems", []).append(cycle_problem)
            state["last_feedback"] = feedback
            state["last_decision"] = output.get("ranked_recommendations", [{}])[0]
            summary_line = self._build_cycle_summary(
                cycle=int(state.get("current_cycle", 0)),
                problem=cycle_problem,
                output=output,
            )
            state.setdefault("cycle_summaries", []).append(summary_line)
            keep_n = max(0, int(pm_cfg.recent_cycle_summaries))
            if keep_n > 0:
                state["cycle_summaries"] = state["cycle_summaries"][-keep_n:]
            else:
                state["cycle_summaries"] = []
            self._save_pm_state(state)
            track_event(
                workspace=self.workspace,
                name="pm_cycle_completed",
                properties={"loop_id": loop_id, "cycle": state["current_cycle"]},
            )
            cycles_done += 1
            if cooldown_seconds > 0 and (run_forever or cycles_done < max_cycles):
                await asyncio.sleep(cooldown_seconds)

        report_path = self.workspace / "data" / "state" / "workflows" / f"{loop_id}_report.json"
        report_path.write_text(
            json.dumps(
                {
                    "loop_id": loop_id,
                    "cycles_executed": cycles_done,
                    "remaining_queue": state.get("problem_queue", []),
                    "last_decision": state.get("last_decision", {}),
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        return {
            "loop_id": loop_id,
            "cycles_executed": cycles_done,
            "state": state,
            "outputs": cycle_outputs,
            "report_path": str(report_path),
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
        skill_names: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """Synchronous wrapper used by scripts/tests."""
        return asyncio.run(
            self.run(
                problem_description,
                context,
                max_iterations,
                session_key,
                stream_callback,
                skill_names,
            )
        )

    def run_pm_loop_sync(
        self,
        *,
        idea: str,
        loop_id: str = "pm_loop_default",
        max_cycles: int = 1,
        run_forever: bool = False,
        simulate_feedback: bool = True,
        cooldown_seconds: int = 0,
        session_key: Optional[str] = None,
    ) -> Dict[str, Any]:
        return asyncio.run(
            self.run_pm_loop(
                idea=idea,
                loop_id=loop_id,
                max_cycles=max_cycles,
                run_forever=run_forever,
                simulate_feedback=simulate_feedback,
                cooldown_seconds=cooldown_seconds,
                session_key=session_key,
            )
        )
