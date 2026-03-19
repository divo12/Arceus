"""Deliverable routes — structured outputs from employee agents."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from arceus.db.models.deliverable import Deliverable
from arceus.db.session import async_session

router = APIRouter(prefix="/startups/{startup_id}/deliverables", tags=["deliverables"])


class DeliverableResponse(BaseModel):
    id: str
    startup_id: str
    task_id: str
    agent_id: str
    deliverable_type: str
    content: dict
    status: str
    reviewed_by_agent_id: str | None = None
    review_feedback: str | None = None
    created_at: str | None = None

    model_config = {"from_attributes": True}


@router.get("", response_model=list[DeliverableResponse])
async def list_deliverables(
    startup_id: str,
    deliverable_type: str | None = None,
    status: str | None = None,
) -> list[DeliverableResponse]:
    async with async_session() as session:
        q = select(Deliverable).where(Deliverable.startup_id == startup_id)
        if deliverable_type:
            q = q.where(Deliverable.deliverable_type == deliverable_type)
        if status:
            q = q.where(Deliverable.status == status)
        q = q.order_by(Deliverable.created_at.desc())
        result = await session.execute(q)
        items = result.scalars().all()
    return [DeliverableResponse.model_validate(d, from_attributes=True) for d in items]


@router.get("/{deliverable_id}", response_model=DeliverableResponse)
async def get_deliverable(
    startup_id: str,
    deliverable_id: str,
) -> DeliverableResponse:
    async with async_session() as session:
        d = await session.get(Deliverable, deliverable_id)
        if not d or d.startup_id != startup_id:
            raise HTTPException(404, "Deliverable not found")
    return DeliverableResponse.model_validate(d, from_attributes=True)
