"""Activity log (tickets) routes."""

from fastapi import APIRouter

router = APIRouter(prefix="/startups/{startup_id}/tickets", tags=["tickets"])


@router.get("")
async def list_tickets(
    startup_id: str,
    page: int = 1,
    per_page: int = 50,
) -> dict:
    return {"items": [], "page": page, "per_page": per_page, "total": 0}


@router.get("/{ticket_id}")
async def get_ticket(startup_id: str, ticket_id: str) -> dict:
    return {"ticket_id": ticket_id}
