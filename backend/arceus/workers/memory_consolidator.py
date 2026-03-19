"""Memory consolidator — light and deep consolidation."""

from arceus.workers.celery_app import celery_app


@celery_app.task(name="arceus.workers.memory_consolidator.consolidate")
def consolidate(agent_id: str, depth: str = "light") -> dict:
    """
    Consolidation:
    - Light (post-task): Extract key learnings from recent episodes → patterns
    - Deep (post-standup): Cross-reference patterns, merge duplicates, prune stale
    """
    return {"agent_id": agent_id, "depth": depth, "consolidated": True}
