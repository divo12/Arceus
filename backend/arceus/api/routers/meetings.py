"""Meeting routes."""

from fastapi import APIRouter

router = APIRouter(prefix="/startups/{startup_id}/meetings", tags=["meetings"])


@router.get("")
async def list_meetings(
    startup_id: str,
    meeting_type: str | None = None,
) -> list:
    return []


@router.get("/upcoming")
async def upcoming_meetings(startup_id: str) -> list:
    return []


@router.get("/{meeting_id}")
async def get_meeting(startup_id: str, meeting_id: str) -> dict:
    return {"meeting_id": meeting_id}
