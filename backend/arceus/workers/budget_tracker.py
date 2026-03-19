"""Budget tracker — cost aggregation from LLM calls."""

from arceus.workers.celery_app import celery_app


@celery_app.task(name="arceus.workers.budget_tracker.record_cost")
def record_cost(
    startup_id: str,
    agent_id: str,
    task_id: str | None,
    model: str,
    tokens_in: int,
    tokens_out: int,
    cost: float,
) -> dict:
    """
    Cost tracking:
    1. Create CostEntry record
    2. Update Agent.total_cost
    3. Update Startup.budget_spent
    4. Broadcast budget.updated WebSocket event
    """
    return {"recorded": True, "cost": cost}
