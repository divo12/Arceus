"""TaskService — task lifecycle management."""

from sqlalchemy.ext.asyncio import AsyncSession

from arceus.db.repos.task import TaskRepo


class TaskService:
    def __init__(self, session: AsyncSession) -> None:
        self.repo = TaskRepo(session)

    async def create(
        self,
        startup_id: str,
        title: str,
        description: str | None = None,
        assigned_to: str | None = None,
        parent_id: str | None = None,
    ) -> dict:
        task = await self.repo.create(
            startup_id=startup_id,
            title=title,
            description=description,
            assigned_to_agent_id=assigned_to,
            parent_task_id=parent_id,
        )
        return {"id": task.id, "title": task.title}

    async def get(self, task_id: str) -> object | None:
        return await self.repo.get(task_id)

    async def list_for_startup(self, startup_id: str, **filters: object) -> list:
        return await self.repo.list_for_startup(startup_id, **filters)

    async def update_status(self, task_id: str, status: str) -> object | None:
        return await self.repo.update(task_id, status=status)
