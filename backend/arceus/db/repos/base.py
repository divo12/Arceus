"""Generic async repository base."""

from typing import Generic, TypeVar

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from arceus.db.models.base import Base

ModelT = TypeVar("ModelT", bound=Base)


class BaseRepo(Generic[ModelT]):
    def __init__(self, session: AsyncSession, model_class: type[ModelT]) -> None:
        self.session = session
        self.model_class = model_class

    async def get(self, id: str) -> ModelT | None:
        return await self.session.get(self.model_class, id)

    async def list_all(self, **filters: object) -> list[ModelT]:
        stmt = select(self.model_class)
        for key, value in filters.items():
            stmt = stmt.where(getattr(self.model_class, key) == value)
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def create(self, **kwargs: object) -> ModelT:
        obj = self.model_class(**kwargs)
        self.session.add(obj)
        await self.session.flush()
        return obj

    async def update(self, id: str, **kwargs: object) -> ModelT | None:
        obj = await self.get(id)
        if obj is None:
            return None
        for key, value in kwargs.items():
            setattr(obj, key, value)
        await self.session.flush()
        return obj

    async def delete(self, id: str) -> bool:
        obj = await self.get(id)
        if obj is None:
            return False
        await self.session.delete(obj)
        await self.session.flush()
        return True
