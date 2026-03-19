"""Dependency injection for FastAPI routes."""

from collections.abc import AsyncGenerator

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from arceus.db.session import get_db
from arceus.db.repos import StartupRepo, AgentRepo, TaskRepo
from arceus.core.services.startup import StartupService
from arceus.core.services.chat import ChatService


async def get_startup_repo(
    db: AsyncSession = Depends(get_db),
) -> StartupRepo:
    return StartupRepo(db)


async def get_agent_repo(
    db: AsyncSession = Depends(get_db),
) -> AgentRepo:
    return AgentRepo(db)


async def get_task_repo(
    db: AsyncSession = Depends(get_db),
) -> TaskRepo:
    return TaskRepo(db)


async def get_startup_service(
    db: AsyncSession = Depends(get_db),
) -> StartupService:
    return StartupService(db)


async def get_chat_service(
    db: AsyncSession = Depends(get_db),
) -> ChatService:
    return ChatService(db)
