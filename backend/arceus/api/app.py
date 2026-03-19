"""FastAPI application factory."""

from contextlib import asynccontextmanager
from collections.abc import AsyncGenerator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from arceus.config.settings import settings


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    import logging
    logging.basicConfig(level=logging.INFO, format="%(name)s - %(levelname)s - %(message)s")
    # Quiet down noisy loggers
    logging.getLogger("sqlalchemy.engine").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("openai").setLevel(logging.WARNING)

    # Startup — create tables and seed dev user
    from arceus.db.session import create_tables, async_session
    await create_tables()

    # Seed a dev user if none exists
    from arceus.db.models.user import User
    from sqlalchemy import select

    async with async_session() as session:
        result = await session.execute(select(User).limit(1))
        if result.scalar_one_or_none() is None:
            session.add(User(id="user-1", email="founder@arceus.dev", name="Founder"))
            await session.commit()

    # Create the orchestrator and attach ws manager
    from arceus.core.services.orchestrator import WorkOrchestrator
    from arceus.api.routers.ws import manager as ws_manager

    orchestrator = WorkOrchestrator(ws_manager=ws_manager)
    app.state.orchestrator = orchestrator

    # Resume work loops for any startups that are already "active"
    from arceus.db.models.startup import Startup

    async with async_session() as session:
        active_result = await session.execute(
            select(Startup.id).where(Startup.status == "active")
        )
        for (sid,) in active_result.all():
            orchestrator.start(sid)

    yield

    # Shutdown — cancel all running loops
    for sid in list(orchestrator._loops):
        orchestrator.pause(sid)

    from arceus.db.session import engine
    await engine.dispose()


def create_app() -> FastAPI:
    app = FastAPI(
        title=settings.app_name,
        version="0.1.0",
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Register routers
    from arceus.api.routers import (
        auth,
        startups,
        hierarchy,
        agents,
        tasks,
        meetings,
        tickets,
        budget,
        approvals,
        chat,
        ws,
        deliverables,
    )

    prefix = "/api"
    app.include_router(auth.router, prefix=prefix)
    app.include_router(startups.router, prefix=prefix)
    app.include_router(hierarchy.router, prefix=prefix)
    app.include_router(agents.router, prefix=prefix)
    app.include_router(tasks.router, prefix=prefix)
    app.include_router(meetings.router, prefix=prefix)
    app.include_router(tickets.router, prefix=prefix)
    app.include_router(budget.router, prefix=prefix)
    app.include_router(approvals.router, prefix=prefix)
    app.include_router(chat.router, prefix=prefix)
    app.include_router(deliverables.router, prefix=prefix)
    app.include_router(ws.router)

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
