"""Approval routes."""

from fastapi import APIRouter

router = APIRouter(prefix="/startups/{startup_id}/approvals", tags=["approvals"])


@router.get("")
async def list_pending(startup_id: str) -> list:
    return []


@router.post("/{approval_id}/accept")
async def accept_approval(startup_id: str, approval_id: str) -> dict:
    return {"approval_id": approval_id, "status": "accepted"}


@router.post("/{approval_id}/reject")
async def reject_approval(startup_id: str, approval_id: str, feedback: str = "") -> dict:
    return {"approval_id": approval_id, "status": "rejected", "feedback": feedback}
