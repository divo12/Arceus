"""Agent executor — runs PydanticAI agent invocations."""

from arceus.workers.celery_app import celery_app


@celery_app.task(name="arceus.workers.agent_executor.execute_task")
def execute_task(agent_id: str, task_id: str) -> dict:
    """
    Execute an agent task:
    1. Load agent config from DB
    2. Load relevant memories from Mem0
    3. Run PydanticAI agent with tools
    4. Record trace entries
    5. Record cost via BudgetService
    6. Update task status
    7. Broadcast WebSocket events
    """
    # TODO: implement with async wrapper
    return {"agent_id": agent_id, "task_id": task_id, "status": "completed"}
