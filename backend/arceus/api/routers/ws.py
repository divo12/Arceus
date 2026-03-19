"""WebSocket handler for real-time dashboard events."""

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

router = APIRouter(tags=["websocket"])


class ConnectionManager:
    """Manages WebSocket connections per startup."""

    def __init__(self) -> None:
        self.active: dict[str, list[WebSocket]] = {}

    async def connect(self, startup_id: str, websocket: WebSocket) -> None:
        await websocket.accept()
        if startup_id not in self.active:
            self.active[startup_id] = []
        self.active[startup_id].append(websocket)

    def disconnect(self, startup_id: str, websocket: WebSocket) -> None:
        if startup_id in self.active:
            self.active[startup_id].remove(websocket)
            if not self.active[startup_id]:
                del self.active[startup_id]

    async def broadcast(self, startup_id: str, event: str, data: dict) -> None:
        if startup_id not in self.active:
            return
        message = {"event": event, **data}
        for ws in self.active[startup_id]:
            await ws.send_json(message)


manager = ConnectionManager()


@router.websocket("/ws/startups/{startup_id}")
async def websocket_endpoint(websocket: WebSocket, startup_id: str) -> None:
    await manager.connect(startup_id, websocket)
    try:
        while True:
            data = await websocket.receive_json()
            # Handle client → server events (subscribe/unsubscribe)
            event = data.get("event")
            if event == "ping":
                await websocket.send_json({"event": "pong"})
    except WebSocketDisconnect:
        manager.disconnect(startup_id, websocket)
