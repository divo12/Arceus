"""AgentService — manage employee and spawned agents."""

from sqlalchemy.ext.asyncio import AsyncSession

from arceus.db.repos.agent import AgentRepo


class AgentService:
    def __init__(self, session: AsyncSession) -> None:
        self.repo = AgentRepo(session)

    async def get(self, agent_id: str) -> object | None:
        return await self.repo.get(agent_id)

    async def list_for_startup(self, startup_id: str, include_spawned: bool = False) -> list:
        return await self.repo.list_for_startup(startup_id, include_spawned)

    async def spawn(
        self, parent_id: str, agent_type: str, task_id: str, config: dict
    ) -> dict:
        """Spawn a new agent (generic, coding, browser, exploratory)."""
        # TODO: create Agent record + enqueue spawn_manager Celery job
        return {"spawned": True}

    async def destroy(self, agent_id: str, distill_to_parent: bool = True) -> None:
        """Destroy spawned agent, optionally distilling its memory to parent."""
        # TODO: distill trajectory → MemoryService → mark agent as destroyed
        pass
