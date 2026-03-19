"""Spawn manager — handles spawned agent lifecycle."""

from arceus.workers.celery_app import celery_app


@celery_app.task(name="arceus.workers.spawn_manager.spawn_agent")
def spawn_agent(parent_id: str, agent_type: str, task_id: str, config: dict) -> dict:
    """
    Spawn lifecycle:
    1. Create agent record (generic/coding/browser/exploratory)
    2. For coding: init GitHub Copilot SDK session
    3. For browser: init browser-use session
    4. Allocate E2B sandbox if needed
    5. Execute the assigned task
    6. Parent verifies result (VerifierState)
    7. Distill trajectory to parent's memory
    8. Destroy spawned agent
    """
    return {"parent_id": parent_id, "agent_type": agent_type, "status": "completed"}
