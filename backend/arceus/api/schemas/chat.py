"""Chat request/response schemas."""

from datetime import datetime

from pydantic import BaseModel


class ChatSend(BaseModel):
    content: str


class ChatMessageResponse(BaseModel):
    model_config = {"from_attributes": True}

    id: str
    role: str
    content: str
    created_at: datetime
