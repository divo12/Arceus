from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from arceus.db.models.agent import Agent
from .base import BaseRepo


class AgentRepo(BaseRepo[Agent]):
    def __init__(self, session: AsyncSession) -> None:
        super().__init__(session, Agent)

    async def list_for_startup(
        self, startup_id: str, include_spawned: bool = False
    ) -> list[Agent]:
        stmt = select(Agent).where(Agent.startup_id == startup_id)
        if not include_spawned:
            stmt = stmt.where(Agent.agent_type == "employee")
        result = await self.session.execute(stmt)
        return list(result.scalars().all())
