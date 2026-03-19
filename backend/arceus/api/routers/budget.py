"""Budget routes."""

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from arceus.api.deps import get_startup_service
from arceus.core.services.startup import StartupService

router = APIRouter(prefix="/startups/{startup_id}/budget", tags=["budget"])


@router.get("")
async def get_budget(
    startup_id: str,
    svc: StartupService = Depends(get_startup_service),
) -> dict:
    startup = await svc.get(startup_id)
    if not startup:
        return {"startup_id": startup_id, "allocated": 0, "spent": 0, "remaining": 0}
    allocated = float(startup.budget_allocated)
    spent = float(startup.budget_spent)
    return {
        "startup_id": startup_id,
        "allocated": allocated,
        "spent": spent,
        "remaining": allocated - spent,
    }


@router.get("/breakdown")
async def get_breakdown(startup_id: str) -> dict:
    return {"by_agent": [], "by_model": [], "by_task": []}


@router.get("/history")
async def get_history(startup_id: str) -> list:
    return []


@router.patch("")
async def update_budget(startup_id: str) -> dict:
    return {"message": "updated"}
