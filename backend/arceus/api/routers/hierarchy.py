"""Hierarchy routes — org chart proposal and approval."""

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from arceus.db.session import get_db
from arceus.core.roles import ROLE_CATALOG
from arceus.core.services.hierarchy import HierarchyService

router = APIRouter(prefix="/startups/{startup_id}/hierarchy", tags=["hierarchy"])


async def get_hierarchy_service(
    db: AsyncSession = Depends(get_db),
) -> HierarchyService:
    return HierarchyService(db)


@router.get("/roles")
async def get_available_roles(startup_id: str) -> dict:
    """Return the catalog of supported roles the system can instantiate."""
    roles = []
    for role in ROLE_CATALOG.values():
        roles.append({
            "role": role.name.value,
            "title": role.title,
            "level": role.level,
            "reports_to": role.reports_to,
            "description": role.description,
        })
    return {"roles": roles}


async def get_hierarchy_service(
    db: AsyncSession = Depends(get_db),
) -> HierarchyService:
    return HierarchyService(db)


@router.get("")
async def get_hierarchy(
    startup_id: str,
    svc: HierarchyService = Depends(get_hierarchy_service),
) -> dict:
    return await svc.get(startup_id)


@router.post("/propose")
async def propose_hierarchy(
    startup_id: str,
    svc: HierarchyService = Depends(get_hierarchy_service),
) -> dict:
    return await svc.propose(startup_id)


class ApproveBody(BaseModel):
    roles: list[dict]


@router.put("/approve")
async def approve_hierarchy(
    startup_id: str,
    body: ApproveBody,
    svc: HierarchyService = Depends(get_hierarchy_service),
) -> dict:
    agents = await svc.approve(startup_id, body.roles)
    return {"startup_id": startup_id, "agents_created": agents}
