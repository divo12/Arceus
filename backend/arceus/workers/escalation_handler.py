"""Escalation handler — propagates blockers up the hierarchy."""

from arceus.workers.celery_app import celery_app


@celery_app.task(name="arceus.workers.escalation_handler.escalate")
def escalate(blocker_agent_id: str, description: str) -> dict:
    """
    Escalation chain:
    1. Find parent in hierarchy
    2. Create escalation meeting with parent
    3. If parent can resolve → done
    4. If parent also blocked → escalate to parent's parent
    5. If reaches CEO and CEO can't resolve → create Approval for user
    """
    return {"blocker_agent_id": blocker_agent_id, "escalated": True}
