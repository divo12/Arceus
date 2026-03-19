"""CEO Chat routes — REST + SSE streaming.

Per ARCEUS.md: CEO ↔ User bidirectional chat. The CEO refines the
FundamentalIdea with the user, reports progress, and requests approvals.
"""

import json

from fastapi import APIRouter, Depends, Request
from sse_starlette.sse import EventSourceResponse

from arceus.api.deps import get_chat_service
from arceus.api.schemas.chat import ChatSend, ChatMessageResponse
from arceus.core.services.chat import ChatService

router = APIRouter(prefix="/startups/{startup_id}/chat", tags=["chat"])


@router.get("/history", response_model=list[ChatMessageResponse])
async def get_chat_history(
    startup_id: str,
    limit: int = 50,
    offset: int = 0,
    svc: ChatService = Depends(get_chat_service),
) -> list[ChatMessageResponse]:
    messages = await svc.get_history(startup_id, limit=limit, offset=offset)
    return [ChatMessageResponse.model_validate(m, from_attributes=True) for m in messages]


@router.post("/send")
async def send_message(
    startup_id: str,
    body: ChatSend,
    request: Request,
    svc: ChatService = Depends(get_chat_service),
) -> EventSourceResponse:
    """Send a message and stream the CEO's response via SSE.

    Events:
      - {"event": "token", "data": "<text chunk>"}
      - {"event": "done", "data": ""}
      - {"event": "error", "data": "<error message>"}
    """

    async def event_generator():
        try:
            async for chunk in svc.send_message_stream(startup_id, body.content):
                if await request.is_disconnected():
                    break
                yield {"event": "token", "data": json.dumps(chunk)}
            yield {"event": "done", "data": ""}
        except Exception as e:
            yield {"event": "error", "data": str(e)}

    return EventSourceResponse(event_generator())
