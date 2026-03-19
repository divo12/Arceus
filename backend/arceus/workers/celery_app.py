"""Celery application configuration."""

from celery import Celery

from arceus.config.settings import settings

celery_app = Celery(
    "arceus",
    broker=settings.celery_broker_url,
    backend=settings.celery_result_backend,
)

celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="UTC",
    enable_utc=True,
    task_track_started=True,
    task_routes={
        "arceus.workers.agent_executor.*": {"queue": "agent_execution"},
        "arceus.workers.spawn_manager.*": {"queue": "agent_spawn"},
        "arceus.workers.meeting_runner.*": {"queue": "meetings"},
        "arceus.workers.escalation_handler.*": {"queue": "escalation"},
        "arceus.workers.memory_consolidator.*": {"queue": "consolidation"},
        "arceus.workers.budget_tracker.*": {"queue": "budget"},
    },
)

celery_app.autodiscover_tasks([
    "arceus.workers.agent_executor",
    "arceus.workers.spawn_manager",
    "arceus.workers.meeting_runner",
    "arceus.workers.escalation_handler",
    "arceus.workers.memory_consolidator",
    "arceus.workers.budget_tracker",
])
