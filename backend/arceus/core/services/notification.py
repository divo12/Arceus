"""NotificationService — toasts via WebSocket + persisted bell notifications."""


class NotificationService:
    async def send_toast(
        self, startup_id: str, title: str, body: str, severity: str = "info"
    ) -> None:
        """Push notification via WebSocket to all connected clients."""
        from arceus.api.routers.ws import manager

        await manager.broadcast(
            startup_id, "notification", {"title": title, "body": body, "severity": severity}
        )

    async def send_bell(self, user_id: str, notification: dict) -> None:
        """Persist a notification for the bell icon."""
        # TODO: create Notification record
        pass

    async def get_history(self, user_id: str, page: int = 1) -> list:
        return []
