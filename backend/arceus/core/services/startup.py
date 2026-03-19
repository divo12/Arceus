"""StartupService — create, manage, and query startups.

Per ARCEUS.md Phase 1: creating a startup instantiates the CEO agent
as the first and only agent. The CEO then engages in bidirectional
chat with the User to refine the FundamentalIdea.
"""

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from arceus.db.models.agent import Agent, AgentType, AgentStatus
from arceus.db.models.startup import Startup
from arceus.db.models.memory import ChatMessage
from arceus.db.repos.startup import StartupRepo
from arceus.core.agents.ceo import CEO_SYSTEM_PROMPT


class StartupService:
    def __init__(self, session: AsyncSession) -> None:
        self.repo = StartupRepo(session)
        self.session = session

    async def create(
        self, user_id: str, name: str, core_idea: str, budget: float
    ) -> Startup:
        """Create a startup and spawn its CEO agent."""
        # 1. Create the startup
        startup = await self.repo.create(
            name=name,
            core_idea=core_idea,
            current_direction=core_idea,  # starts same as core_idea
            budget_allocated=budget,
            owner_id=user_id,
        )

        # 2. Spawn CEO agent — per ARCEUS.md, this is the first and only agent
        ceo = Agent(
            startup_id=startup.id,
            name="CEO",
            role="CEO",
            agent_type=AgentType.EMPLOYEE,
            status=AgentStatus.IDLE,
            level=0,
            system_prompt=CEO_SYSTEM_PROMPT,
        )
        self.session.add(ceo)
        await self.session.flush()

        # 3. Seed initial CEO message — the CEO introduces itself
        intro = ChatMessage(
            startup_id=startup.id,
            role="assistant",
            content=(
                f"Hello! I'm the CEO of **{name}**. I've received your core idea:\n\n"
                f"> {core_idea}\n\n"
                "Before I build out the team, I'd like to understand your vision better. "
                "What problem are you solving, and who is your target user? "
                "What does success look like in the first 3 months?"
            ),
        )
        self.session.add(intro)
        await self.session.flush()

        return startup

    async def get(self, startup_id: str) -> Startup | None:
        return await self.repo.get(startup_id)

    async def list_for_user(self, user_id: str) -> list[Startup]:
        return await self.repo.list_all(owner_id=user_id)

    async def update_status(self, startup_id: str, status: str) -> Startup | None:
        """Update startup status (active / paused / archived)."""
        startup = await self.repo.get(startup_id)
        if not startup:
            return None
        startup.status = status
        await self.session.flush()
        return startup

    async def get_overview(self, startup_id: str) -> dict:
        """Aggregate overview stats from the DB."""
        from arceus.db.models.task import Task
        from arceus.db.models.memory import Approval

        startup = await self.repo.get(startup_id)
        if not startup:
            return {}

        # Count agents
        agents_q = await self.session.execute(
            select(func.count(Agent.id)).where(Agent.startup_id == startup_id)
        )
        agents_total = agents_q.scalar() or 0

        running_q = await self.session.execute(
            select(func.count(Agent.id)).where(
                Agent.startup_id == startup_id, Agent.status == AgentStatus.RUNNING
            )
        )
        agents_running = running_q.scalar() or 0

        # Count tasks
        open_q = await self.session.execute(
            select(func.count(Task.id)).where(
                Task.startup_id == startup_id,
                Task.status.in_(["planned", "in_progress", "blocked"]),
            )
        )
        tasks_open = open_q.scalar() or 0

        completed_q = await self.session.execute(
            select(func.count(Task.id)).where(
                Task.startup_id == startup_id, Task.status == "completed"
            )
        )
        tasks_completed = completed_q.scalar() or 0

        # Pending approvals
        approvals_q = await self.session.execute(
            select(func.count(Approval.id)).where(
                Approval.startup_id == startup_id, Approval.status == "pending"
            )
        )
        pending_approvals = approvals_q.scalar() or 0

        return {
            "startup_id": startup_id,
            "employees_total": agents_total,
            "employees_running": agents_running,
            "tasks_open": tasks_open,
            "tasks_completed": tasks_completed,
            "budget_spent": float(startup.budget_spent),
            "budget_allocated": float(startup.budget_allocated),
            "pending_approvals": pending_approvals,
        }
