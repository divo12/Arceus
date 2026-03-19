from sqlalchemy.ext.asyncio import AsyncSession

from arceus.db.models.startup import Startup, StartupMember
from .base import BaseRepo


class StartupRepo(BaseRepo[Startup]):
    def __init__(self, session: AsyncSession) -> None:
        super().__init__(session, Startup)


class StartupMemberRepo(BaseRepo[StartupMember]):
    def __init__(self, session: AsyncSession) -> None:
        super().__init__(session, StartupMember)
