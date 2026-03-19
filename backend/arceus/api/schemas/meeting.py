"""Meeting request/response schemas."""

from pydantic import BaseModel


class MeetingResponse(BaseModel):
    model_config = {"from_attributes": True}

    id: str
    meeting_type: str
    status: str
    participant_ids: list[str] | None = None
    decisions: list[dict] | None = None
    learnings: list[dict] | None = None
