"""Controller entrypoint for running the PM agent loop."""

import asyncio
from pathlib import Path
from typing import Any, Dict, Optional

from execution.agent_loop import AgentLoop
from heartbeat.service import HeartbeatService


class Controller:
    """Thin orchestration layer over AgentLoop and HeartbeatService."""

    def __init__(self, workspace: Path):
        self.workspace = Path(workspace).expanduser().resolve()
        self.loop = AgentLoop(self.workspace)
        self._heartbeat: Optional[HeartbeatService] = None

    def run_problem(
        self, problem_description: str, context: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        return self.loop.run_sync(problem_description=problem_description, context=context)

    async def _on_heartbeat(self, prompt: str) -> str:
        """Callback for heartbeat: run agent and return final response text."""
        result = await self.loop.run(problem_description=prompt)
        return result.get("final", {}).get("content", "HEARTBEAT_OK")

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
    ) -> None:
        """
        Run the gateway: heartbeat loop that periodically wakes the agent.
        Use for autonomous 24/7 operation. Blocks until cancelled.
        """
        self._heartbeat = HeartbeatService(
            workspace=self.workspace,
            on_heartbeat=self._on_heartbeat,
            interval_s=heartbeat_interval_s,
            enabled=heartbeat_enabled,
        )
        await self._heartbeat.start()
        try:
            while self._heartbeat._running:
                await asyncio.sleep(10)
        except asyncio.CancelledError:
            pass
        finally:
            if self._heartbeat:
                self._heartbeat.stop()

    def run_gateway_sync(
        self,
        heartbeat_interval_s: int = 30 * 60,
        heartbeat_enabled: bool = True,
    ) -> None:
        """Synchronous wrapper for run_gateway."""
        asyncio.run(self.run_gateway(heartbeat_interval_s, heartbeat_enabled))
