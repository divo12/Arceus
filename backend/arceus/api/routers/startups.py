"""Startup CRUD routes."""

from fastapi import APIRouter, Depends, HTTPException, Request

from arceus.api.deps import get_startup_service
from arceus.api.schemas.startup import (
    StartupCreate,
    StartupResponse,
    StartupOverview,
    StartupStatusUpdate,
    MemberInvite,
    MemberResponse,
)
from arceus.core.services.startup import StartupService

router = APIRouter(prefix="/startups", tags=["startups"])


@router.post("", response_model=StartupResponse)
async def create_startup(
    body: StartupCreate,
    svc: StartupService = Depends(get_startup_service),
) -> StartupResponse:
    startup = await svc.create(
        user_id="user-1",  # TODO: from auth
        name=body.name,
        core_idea=body.core_idea,
        budget=body.budget,
    )
    return StartupResponse.model_validate(startup, from_attributes=True)


@router.get("", response_model=list[StartupResponse])
async def list_startups(
    svc: StartupService = Depends(get_startup_service),
) -> list[StartupResponse]:
    startups = await svc.list_for_user(user_id="user-1")
    return [StartupResponse.model_validate(s, from_attributes=True) for s in startups]


@router.get("/{startup_id}", response_model=StartupResponse)
async def get_startup(
    startup_id: str,
    svc: StartupService = Depends(get_startup_service),
) -> StartupResponse:
    startup = await svc.get(startup_id)
    if not startup:
        raise HTTPException(404, "Startup not found")
    return StartupResponse.model_validate(startup, from_attributes=True)


@router.patch("/{startup_id}/status", response_model=StartupResponse)
async def update_status(
    startup_id: str,
    body: StartupStatusUpdate,
    request: Request,
    svc: StartupService = Depends(get_startup_service),
) -> StartupResponse:
    if body.status not in ("active", "paused", "archived"):
        raise HTTPException(400, "Invalid status. Must be: active, paused, archived")
    startup = await svc.update_status(startup_id, body.status)
    if not startup:
        raise HTTPException(404, "Startup not found")

    # Wire orchestrator start/pause
    orchestrator = request.app.state.orchestrator
    if body.status == "active":
        orchestrator.start(startup_id)
    elif body.status in ("paused", "archived"):
        orchestrator.pause(startup_id)

    return StartupResponse.model_validate(startup, from_attributes=True)


@router.get("/{startup_id}/overview", response_model=StartupOverview)
async def get_overview(
    startup_id: str,
    svc: StartupService = Depends(get_startup_service),
) -> StartupOverview:
    data = await svc.get_overview(startup_id)
    if not data:
        raise HTTPException(404, "Startup not found")
    return StartupOverview(**data)
