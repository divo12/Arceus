"""ApprovalService — user decision queue for escalated items."""


class ApprovalService:
    async def create(
        self,
        startup_id: str,
        approval_type: str,
        description: str,
        from_agent: str | None = None,
    ) -> dict:
        return {"created": True}

    async def list_pending(self, startup_id: str) -> list:
        return []

    async def accept(self, approval_id: str) -> None:
        pass

    async def reject(self, approval_id: str, feedback: str = "") -> None:
        pass
