"""BudgetService — cost tracking and aggregation."""


class BudgetService:
    async def record_cost(
        self,
        agent_id: str,
        task_id: str | None,
        model: str,
        tokens_in: int,
        tokens_out: int,
        cost: float,
    ) -> None:
        """Record a single LLM call cost."""
        # TODO: create CostEntry + update agent/startup totals
        pass

    async def get_overview(self, startup_id: str) -> dict:
        return {"allocated": 0, "spent": 0, "remaining": 0}

    async def get_breakdown(self, startup_id: str) -> dict:
        return {"by_agent": [], "by_model": []}

    async def update_allocation(self, startup_id: str, new_total: float) -> dict:
        return {"allocated": new_total}
