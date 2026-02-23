"""Controller entrypoint for running the PM agent loop."""

import asyncio
import json
from pathlib import Path
from typing import Any, Dict, Optional

from agents.tools.cron import CronTool
from cron.service import CronService
from cron.types import CronJob
from execution.agent_loop import AgentLoop
from heartbeat.service import HeartbeatService
from providers.adapter import ProviderAdapter


class Controller:
    """Thin orchestration layer over AgentLoop, HeartbeatService, and CronService."""

    def __init__(self, workspace: Path, provider: Optional[ProviderAdapter] = None):
        self.workspace = Path(workspace).expanduser().resolve()
        self.loop = AgentLoop(self.workspace, provider=provider)
        self._heartbeat: Optional[HeartbeatService] = None
        self._cron: Optional[CronService] = None

        # Cron service: persist jobs, run agent when due
        store_path = self.workspace / ".arceus" / "cron.json"
        self._cron = CronService(
            store_path=store_path,
            on_job=self._on_cron_job,
        )
        self.loop.registry.register(CronTool(self._cron))

    def run_problem(
        self,
        problem_description: str,
        context: Optional[Dict[str, Any]] = None,
        max_iterations: Optional[int] = None,
        session_key: Optional[str] = None,
        stream_callback: Optional[Any] = None,
    ) -> Dict[str, Any]:
        return self.loop.run_sync(
            problem_description=problem_description,
            context=context,
            max_iterations=max_iterations,
            session_key=session_key,
            stream_callback=stream_callback,
        )

    def run_pm_problem(
        self,
        idea: str,
        loop_id: str = "pm_loop_default",
        max_cycles: int = 1,
        run_forever: bool = False,
        simulate_feedback: bool = True,
        cooldown_seconds: int = 0,
        session_key: Optional[str] = None,
    ) -> Dict[str, Any]:
        return self.loop.run_pm_loop_sync(
            idea=idea,
            loop_id=loop_id,
            max_cycles=max_cycles,
            run_forever=run_forever,
            simulate_feedback=simulate_feedback,
            cooldown_seconds=cooldown_seconds,
            session_key=session_key,
        )

    async def _on_heartbeat(self, prompt: str) -> str:
        """Callback for heartbeat: run agent with extra iterations for relentless task execution."""
        heartbeat_file = self.workspace / "HEARTBEAT.md"
        if heartbeat_file.exists():
            try:
                heartbeat_content = heartbeat_file.read_text(encoding="utf-8")
            except OSError:
                heartbeat_content = ""
            for raw_line in heartbeat_content.splitlines():
                line = raw_line.strip()
                if line.lower().startswith("pm_loop:"):
                    idea = line.split(":", 1)[1].strip() or "PM loop heartbeat task"
                    loop_result = await self.loop.run_pm_loop(
                        idea=idea,
                        loop_id="pm_loop_heartbeat",
                        max_cycles=1,
                        simulate_feedback=True,
                    )
                    return (
                        f"PM_LOOP_OK cycles={loop_result.get('cycles_executed')} "
                        f"remaining={len(loop_result.get('state', {}).get('problem_queue', []))}"
                    )
        if prompt.strip().lower().startswith("pm_loop:"):
            idea = prompt.split(":", 1)[1].strip() or "PM loop heartbeat task"
            loop_result = await self.loop.run_pm_loop(
                idea=idea,
                loop_id="pm_loop_heartbeat",
                max_cycles=1,
                simulate_feedback=True,
            )
            return (
                f"PM_LOOP_OK cycles={loop_result.get('cycles_executed')} "
                f"remaining={len(loop_result.get('state', {}).get('problem_queue', []))}"
            )
        result = await self.loop.run(
            problem_description=prompt,
            max_iterations=12,
        )
        return result.get("final", {}).get("content", "HEARTBEAT_OK")

    async def _on_cron_job(self, job: CronJob) -> str | None:
        """Callback for cron: run agent with job message or dispatch to ideas sweep."""
        def _raise_if_error(content: str | None) -> None:
            if content and content.strip().startswith("Error:"):
                raise RuntimeError(content.strip())

        kind = job.payload.kind
        if kind == "ideas_sweep":
            from pm_ideas.service import run_ideas_sweep_with_loop_async

            content = await run_ideas_sweep_with_loop_async(self.workspace, self.loop)
            _raise_if_error(content)
            return content
        if kind == "new_ideas":
            from pm_ideas.service import run_new_ideas_sweep_with_loop_async

            content = await run_new_ideas_sweep_with_loop_async(self.workspace, self.loop)
            _raise_if_error(content)
            return content
        if kind == "pm_loop":
            prompt = job.payload.message or "PM loop: decide what to build next"
            loop_result = await self.loop.run_pm_loop(
                idea=prompt,
                loop_id="pm_loop_default",
                max_cycles=1,
                run_forever=self.loop.config.agents.pm_loop.single_run_infinite,
                simulate_feedback=True,
            )
            content = json.dumps(
                {
                    "loop_id": loop_result.get("loop_id"),
                    "cycles_executed": loop_result.get("cycles_executed"),
                    "remaining_queue": len(loop_result.get("state", {}).get("problem_queue", [])),
                }
            )
            return content
        prompt = job.payload.message or job.name
        result = await self.loop.run(problem_description=prompt)
        content = result.get("final", {}).get("content")
        _raise_if_error(content)
        return content

    def run_heartbeat_once(self) -> Optional[str]:
        """Run a single heartbeat tick (read HEARTBEAT.md, execute if needed)."""
        svc = HeartbeatService(
            workspace=self.workspace,
            on_heartbeat=self._on_heartbeat,
            enabled=True,
        )
        return asyncio.run(svc.trigger_now())

    async def run_gateway(
        self,
        heartbeat_interval_s: int = 30 * 60,
        heartbeat_enabled: bool = True,
        cron_enabled: bool = True,
    ) -> None:
        """
        Run the gateway: heartbeat + cron services for autonomous 24/7 operation.
        Blocks until cancelled.
        """
        self._heartbeat = HeartbeatService(
            workspace=self.workspace,
            on_heartbeat=self._on_heartbeat,
            interval_s=heartbeat_interval_s,
            enabled=heartbeat_enabled,
        )
        await self._heartbeat.start()

        if cron_enabled and self._cron:
            await self._cron.start()

        try:
            while self._heartbeat._running:
                await asyncio.sleep(10)
        except asyncio.CancelledError:
            pass
        finally:
            if self._cron:
                self._cron.stop()
            if self._heartbeat:
                self._heartbeat.stop()

    def run_gateway_sync(
        self,
        heartbeat_interval_s: int = 30 * 60,
        heartbeat_enabled: bool = True,
        cron_enabled: bool = True,
    ) -> None:
        """Synchronous wrapper for run_gateway."""
        asyncio.run(
            self.run_gateway(
                heartbeat_interval_s, heartbeat_enabled, cron_enabled
            )
        )
