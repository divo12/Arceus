from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from arceus.db.models.task import Task, TraceEntry
from .base import BaseRepo


class TaskRepo(BaseRepo[Task]):
    def __init__(self, session: AsyncSession) -> None:
        super().__init__(session, Task)

    async def list_for_startup(self, startup_id: str, **filters: object) -> list[Task]:
        stmt = select(Task).where(Task.startup_id == startup_id)
        for key, value in filters.items():
            stmt = stmt.where(getattr(Task, key) == value)
        result = await self.session.execute(stmt)
        return list(result.scalars().all())


class TraceEntryRepo(BaseRepo[TraceEntry]):
    def __init__(self, session: AsyncSession) -> None:
        super().__init__(session, TraceEntry)
