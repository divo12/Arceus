"""WorkOrchestrator — background async loop that runs the startup.

When user clicks "Start Company" (status → active), this kicks off:
1. CEO decomposes idea into tasks (if none exist)
2. Employees pick up and execute tasks in parallel
3. Meetings auto-trigger based on work state
4. WebSocket broadcasts keep the dashboard live
5. Loop repeats until paused or all tasks done
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from pydantic_ai import Agent
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from arceus.config.settings import settings
from arceus.core.agents.model_factory import build_model
from arceus.core.schemas.deliverables import AgentOutput, TaskDecomposition
from arceus.core.services.executor import AgentExecutor
from arceus.db.models.agent import Agent as AgentModel, AgentStatus
from arceus.db.models.deliverable import Deliverable
from arceus.db.models.memory import ChatMessage
from arceus.db.models.startup import Startup
from arceus.db.models.task import Task, TaskStatus
from arceus.db.session import async_session

logger = logging.getLogger(__name__)

# Time between work cycles (seconds)
CYCLE_INTERVAL = 5
# Tasks completed before triggering a standup
STANDUP_THRESHOLD = 5


class WorkOrchestrator:
    """Manages background work loops for active startups."""

    def __init__(self, ws_manager: Any = None) -> None:
        self._loops: dict[str, asyncio.Task] = {}
        self._cancelled: set[str] = set()
        self.ws_manager = ws_manager

    def start(self, startup_id: str) -> None:
        """Start the autonomous work loop for a startup."""
        if startup_id in self._loops and not self._loops[startup_id].done():
            logger.info("Work loop already running for %s", startup_id)
            return

        self._cancelled.discard(startup_id)
        task = asyncio.create_task(self._run_loop(startup_id))
        self._loops[startup_id] = task
        logger.info("Started work loop for startup %s", startup_id)

    def pause(self, startup_id: str) -> None:
        """Pause the work loop for a startup."""
        self._cancelled.add(startup_id)
        task = self._loops.pop(startup_id, None)
        if task and not task.done():
            task.cancel()
        logger.info("Paused work loop for startup %s", startup_id)

    def is_running(self, startup_id: str) -> bool:
        task = self._loops.get(startup_id)
        return task is not None and not task.done()

    async def _broadcast(self, startup_id: str, event_type: str, payload: dict) -> None:
        """Send a WebSocket event to connected dashboard clients."""
        if self.ws_manager:
            try:
                await self.ws_manager.broadcast(startup_id, event_type, payload)
            except Exception:
                pass

    async def _run_loop(self, startup_id: str) -> None:
        """Main autonomous work loop."""
        logger.info("Work loop starting for %s", startup_id)
        tasks_since_standup = 0

        try:
            while startup_id not in self._cancelled:
                async with async_session() as session:
                    startup = await session.get(Startup, startup_id)
                    if not startup or startup.status != "active":
                        logger.info("Startup %s no longer active, stopping loop", startup_id)
                        break

                    # Check budget
                    if float(startup.budget_spent) >= float(startup.budget_allocated):
                        logger.info("Budget exhausted for %s, pausing", startup_id)
                        startup.status = "paused"
                        await session.commit()
                        await self._broadcast(startup_id, "budget_exhausted", {})
                        break

                    startup_context = {
                        "name": startup.name,
                        "core_idea": startup.core_idea,
                        "current_direction": startup.current_direction,
                        "budget_allocated": float(startup.budget_allocated),
                        "budget_spent": float(startup.budget_spent),
                    }

                    # Step 1: If no tasks exist, CEO decomposes the idea
                    task_count = await session.execute(
                        select(func.count(Task.id)).where(Task.startup_id == startup_id)
                    )
                    if (task_count.scalar() or 0) == 0:
                        await self._ceo_decompose(session, startup_id, startup_context)
                        await session.commit()
                        await self._broadcast(startup_id, "ceo_decomposed", {})
                        continue

                    # Step 2: Find idle employees with pending tasks
                    completed_count = await self._execute_work_cycle(
                        session, startup_id, startup_context
                    )
                    await session.commit()

                    tasks_since_standup += completed_count

                    # Step 3: Check for deliverables needing spec review
                    await self._check_spec_reviews(session, startup_id, startup_context)
                    await session.commit()

                    # Step 4: Standup after threshold
                    if tasks_since_standup >= STANDUP_THRESHOLD:
                        await self._run_standup(session, startup_id, startup_context)
                        await session.commit()
                        tasks_since_standup = 0

                    # Step 5: Check if all tasks are done
                    remaining = await session.execute(
                        select(func.count(Task.id)).where(
                            Task.startup_id == startup_id,
                            Task.status.in_([TaskStatus.PLANNED, TaskStatus.IN_PROGRESS, TaskStatus.BLOCKED]),
                        )
                    )
                    if (remaining.scalar() or 0) == 0:
                        logger.info("All tasks complete for %s", startup_id)
                        await self._broadcast(startup_id, "all_tasks_complete", {})
                        # CEO posts completion message
                        msg = ChatMessage(
                            startup_id=startup_id,
                            role="assistant",
                            content=(
                                "**All tasks are complete!** The team has finished the current work cycle. "
                                "Check the **Tasks** tab for deliverables and the **Meetings** tab for notes. "
                                "You can start a new cycle by giving me new direction."
                            ),
                        )
                        session.add(msg)
                        await session.commit()
                        break

                # Pause between cycles
                await asyncio.sleep(CYCLE_INTERVAL)

        except asyncio.CancelledError:
            logger.info("Work loop cancelled for %s", startup_id)
        except Exception:
            logger.exception("Work loop crashed for %s", startup_id)
        finally:
            self._loops.pop(startup_id, None)
            self._cancelled.discard(startup_id)

    async def _ceo_decompose(
        self,
        session: AsyncSession,
        startup_id: str,
        startup_context: dict,
    ) -> None:
        """CEO creates initial tasks from the startup idea."""
        # Find CEO agent
        result = await session.execute(
            select(AgentModel).where(
                AgentModel.startup_id == startup_id,
                AgentModel.role == "CEO",
            )
        )
        ceo = result.scalar_one_or_none()
        if not ceo:
            logger.error("No CEO found for startup %s", startup_id)
            return

        # Get team roster
        team_result = await session.execute(
            select(AgentModel).where(
                AgentModel.startup_id == startup_id,
                AgentModel.role != "CEO",
            )
        )
        team = team_result.scalars().all()
        team_desc = "\n".join(f"- {a.role}: {a.name}" for a in team)

        model = build_model(settings.model_ceo)
        agent = Agent(
            model=model,
            system_prompt=(
                "You are the CEO. The board has started the company. "
                "Decompose the startup idea into 3-5 high-level goals as tasks. "
                "Each task should be assigned to a specific team member by their role name. "
                "Think strategically — what are the most important things to build first?"
            ),
            output_type=TaskDecomposition,
        )

        prompt = (
            f"Company: {startup_context['name']}\n"
            f"Core Idea: {startup_context['core_idea']}\n"
            f"Direction: {startup_context['current_direction']}\n"
            f"Budget: ${startup_context['budget_allocated']:.2f}\n\n"
            f"Team:\n{team_desc}\n\n"
            "Decompose this into 3-5 top-level tasks and assign each to the right team member."
        )

        try:
            result = await agent.run(prompt)
            decomposition: TaskDecomposition = result.output

            # Create tasks in DB — fuzzy-match roles
            role_to_agent = {a.role: a for a in team}
            role_lower = {a.role.lower(): a for a in team}
            created_tasks = []

            def _match(role_str: str) -> AgentModel | None:
                if role_str in role_to_agent:
                    return role_to_agent[role_str]
                low = role_str.lower()
                if low in role_lower:
                    return role_lower[low]
                for key, agent in role_lower.items():
                    if low in key or key in low:
                        return agent
                for word in low.split():
                    if word in ("the", "a", "an", "and", "or", "for"):
                        continue
                    for key, agent in role_lower.items():
                        if word in key:
                            return agent
                return None

            for sub in decomposition.tasks:
                assigned_agent = _match(sub.assign_to_role)
                task = Task(
                    startup_id=startup_id,
                    title=sub.title,
                    description=sub.description,
                    priority=sub.priority,
                    assigned_to_agent_id=assigned_agent.id if assigned_agent else None,
                    created_by_agent_id=ceo.id,
                )
                session.add(task)
                created_tasks.append(sub)

            await session.flush()

            # CEO posts update in chat
            task_list = "\n".join(
                f"- **{t.title}** → {t.assign_to_role} ({t.priority})"
                for t in decomposition.tasks
            )
            msg = ChatMessage(
                startup_id=startup_id,
                role="assistant",
                content=(
                    f"**Company started!** I've broken down our vision into {len(created_tasks)} initial tasks:\n\n"
                    f"{task_list}\n\n"
                    f"*Strategy: {decomposition.summary}*\n\n"
                    "The team is now picking these up. Watch the **Tasks** tab for live progress."
                ),
            )
            session.add(msg)

            logger.info("CEO decomposed idea for %s into %d tasks", startup_id, len(created_tasks))

            await self._broadcast(startup_id, "tasks_created", {
                "count": len(created_tasks),
            })

        except Exception:
            logger.exception("CEO decomposition failed for %s", startup_id)

    async def _execute_work_cycle(
        self,
        session: AsyncSession,
        startup_id: str,
        startup_context: dict,
    ) -> int:
        """Find idle employees with pending tasks and execute them."""
        # Get all idle employees (non-CEO)
        idle_result = await session.execute(
            select(AgentModel).where(
                AgentModel.startup_id == startup_id,
                AgentModel.status == AgentStatus.IDLE,
                AgentModel.role != "CEO",
            )
        )
        idle_agents = idle_result.scalars().all()
        if not idle_agents:
            return 0

        executor = AgentExecutor(session)
        completed = 0

        for agent_row in idle_agents:
            # Find a planned task assigned to this agent
            task_result = await session.execute(
                select(Task).where(
                    Task.startup_id == startup_id,
                    Task.assigned_to_agent_id == agent_row.id,
                    Task.status == TaskStatus.PLANNED,
                ).limit(1)
            )
            task = task_result.scalar_one_or_none()

            # If no assigned task, pick up an unassigned one and claim it
            if not task:
                unassigned_result = await session.execute(
                    select(Task).where(
                        Task.startup_id == startup_id,
                        Task.assigned_to_agent_id.is_(None),
                        Task.status == TaskStatus.PLANNED,
                    ).limit(1)
                )
                task = unassigned_result.scalar_one_or_none()
                if task:
                    task.assigned_to_agent_id = agent_row.id
                    await session.flush()

            if not task:
                continue

            await self._broadcast(startup_id, "task_started", {
                "task_id": task.id,
                "agent_id": agent_row.id,
                "agent_role": agent_row.role,
                "task_title": task.title,
            })

            deliverable = await executor.execute(agent_row, task, startup_context)

            if deliverable:
                completed += 1
                await self._broadcast(startup_id, "task_completed", {
                    "task_id": task.id,
                    "agent_id": agent_row.id,
                    "agent_role": agent_row.role,
                    "task_title": task.title,
                    "deliverable_type": deliverable.deliverable_type,
                })

                # If the output is a TaskDecomposition, create the sub-tasks
                if deliverable.deliverable_type == "task_decomposition":
                    await self._handle_decomposition(
                        session, startup_id, task, deliverable, agent_row
                    )

        return completed

    async def _handle_decomposition(
        self,
        session: AsyncSession,
        startup_id: str,
        parent_task: Task,
        deliverable: Deliverable,
        decomposer: AgentModel,
    ) -> None:
        """When an employee decomposes a task, create the sub-tasks."""
        content = deliverable.content
        tasks_data = content.get("tasks", [])

        # Lookup agents by role
        agents_result = await session.execute(
            select(AgentModel).where(AgentModel.startup_id == startup_id)
        )
        all_agents = list(agents_result.scalars().all())
        role_to_agent = {a.role: a for a in all_agents}

        # Build lowercase index for fuzzy matching
        role_lower = {a.role.lower(): a for a in all_agents if a.role != "CEO"}

        def _match_agent(role_str: str) -> AgentModel | None:
            """Best-effort match an LLM role string to an actual agent."""
            # Exact match first
            if role_str in role_to_agent:
                return role_to_agent[role_str]
            # Case-insensitive
            low = role_str.lower()
            if low in role_lower:
                return role_lower[low]
            # Substring match (e.g. "ML Researcher" matches "ML Engineer")
            for key, agent in role_lower.items():
                if low in key or key in low:
                    return agent
            # Keyword match (e.g. "Data Scientist" matches "Data Engineer")
            for word in low.split():
                if word in ("the", "a", "an", "and", "or", "for"):
                    continue
                for key, agent in role_lower.items():
                    if word in key:
                        return agent
            return None

        for sub in tasks_data:
            assigned = _match_agent(sub.get("assign_to_role", ""))
            task = Task(
                startup_id=startup_id,
                title=sub.get("title", "Untitled"),
                description=sub.get("description", ""),
                priority=sub.get("priority", "medium"),
                parent_task_id=parent_task.id,
                assigned_to_agent_id=assigned.id if assigned else None,
                created_by_agent_id=decomposer.id,
            )
            session.add(task)

        await session.flush()
        logger.info(
            "Decomposed task '%s' into %d sub-tasks",
            parent_task.title, len(tasks_data),
        )

    async def _check_spec_reviews(
        self,
        session: AsyncSession,
        startup_id: str,
        startup_context: dict,
    ) -> None:
        """Auto-trigger spec reviews for draft deliverables."""
        # Find draft deliverables that aren't task_decomposition
        drafts_result = await session.execute(
            select(Deliverable).where(
                Deliverable.startup_id == startup_id,
                Deliverable.status == "draft",
                Deliverable.deliverable_type != "task_decomposition",
            ).limit(3)
        )
        drafts = drafts_result.scalars().all()
        if not drafts:
            return

        # Find PM or a managerial role to review
        reviewer_result = await session.execute(
            select(AgentModel).where(
                AgentModel.startup_id == startup_id,
                AgentModel.role.in_(["PM", "CTO", "CEO"]),
            ).order_by(
                # Prefer PM, then CTO, then CEO
                AgentModel.role.desc()
            )
        )
        reviewer = reviewer_result.scalars().first()
        if not reviewer:
            return

        model = build_model(settings.model_employee)

        for draft in drafts:
            # LLM reviews the deliverable
            review_agent = Agent(
                model=model,
                system_prompt=(
                    f"You are the {reviewer.role} reviewing a deliverable. "
                    "Evaluate it for completeness, correctness, and alignment with the startup's goals. "
                    "Respond with ONLY valid JSON: "
                    '{"verdict": "approved" or "rejected", "feedback": "your feedback"}'
                ),
            )

            try:
                review_result = await review_agent.run(
                    f"Startup: {startup_context['name']}\n"
                    f"Idea: {startup_context['core_idea']}\n\n"
                    f"Deliverable type: {draft.deliverable_type}\n"
                    f"Content: {json.dumps(draft.content, indent=2)[:3000]}"
                )
                raw = str(review_result.output)
                # Parse review
                start = raw.find("{")
                end = raw.rfind("}") + 1
                if start >= 0 and end > start:
                    review_data = json.loads(raw[start:end])
                else:
                    review_data = {"verdict": "approved", "feedback": "Looks good."}

                draft.status = review_data.get("verdict", "approved")
                draft.reviewed_by_agent_id = reviewer.id
                draft.review_feedback = review_data.get("feedback", "")

                # If approved, inject knowledge to relevant agents
                if draft.status == "approved":
                    await self._transfer_knowledge(
                        session, startup_id, draft, reviewer
                    )

                await self._broadcast(startup_id, "deliverable_reviewed", {
                    "deliverable_id": draft.id,
                    "deliverable_type": draft.deliverable_type,
                    "verdict": draft.status,
                    "reviewer": reviewer.role,
                })

            except Exception:
                logger.exception("Spec review failed for deliverable %s", draft.id)
                draft.status = "approved"  # Don't block on review failures

        await session.flush()

    async def _transfer_knowledge(
        self,
        session: AsyncSession,
        startup_id: str,
        deliverable: Deliverable,
        reviewer: AgentModel,
    ) -> None:
        """Transfer approved deliverable knowledge to relevant agents."""
        summary = deliverable.content.get("summary", "")
        dtype = deliverable.deliverable_type
        knowledge = f"[{dtype}] {summary}"

        # Determine who needs to know based on deliverable type
        target_roles: list[str] = []
        if dtype == "technical_spec":
            target_roles = ["Backend Developer", "Frontend Developer", "Full-stack Developer",
                           "DevOps Engineer", "QA Engineer", "ML Engineer", "Data Engineer"]
        elif dtype == "api_design":
            target_roles = ["Frontend Developer", "Full-stack Developer", "QA Engineer"]
        elif dtype == "data_model":
            target_roles = ["Backend Developer", "Full-stack Developer", "Frontend Developer"]
        elif dtype == "ui_spec":
            target_roles = ["Frontend Developer", "Full-stack Developer", "Designer"]
        elif dtype == "research_report":
            target_roles = ["CEO", "CTO", "PM"]

        if not target_roles:
            return

        agents_result = await session.execute(
            select(AgentModel).where(
                AgentModel.startup_id == startup_id,
                AgentModel.role.in_(target_roles),
            )
        )
        for agent in agents_result.scalars().all():
            memory = list(agent.agent_memory or [])
            memory.append(knowledge)
            agent.agent_memory = memory

        await session.flush()

    async def _run_standup(
        self,
        session: AsyncSession,
        startup_id: str,
        startup_context: dict,
    ) -> None:
        """Run an automatic standup meeting."""
        from arceus.db.models.meeting import Meeting, MeetingType, MeetingStatus

        # Gather status from all agents
        agents_result = await session.execute(
            select(AgentModel).where(AgentModel.startup_id == startup_id)
        )
        agents = agents_result.scalars().all()

        agent_statuses = []
        for a in agents:
            # Count tasks
            completed_q = await session.execute(
                select(func.count(Task.id)).where(
                    Task.assigned_to_agent_id == a.id,
                    Task.status == TaskStatus.COMPLETED,
                )
            )
            pending_q = await session.execute(
                select(func.count(Task.id)).where(
                    Task.assigned_to_agent_id == a.id,
                    Task.status == TaskStatus.PLANNED,
                )
            )
            agent_statuses.append({
                "role": a.role,
                "name": a.name,
                "status": a.status,
                "tasks_completed": completed_q.scalar() or 0,
                "tasks_pending": pending_q.scalar() or 0,
            })

        # CEO synthesizes standup
        model = build_model(settings.model_ceo)
        standup_agent = Agent(
            model=model,
            system_prompt=(
                "You are the CEO running a standup meeting. "
                "Summarize team progress, identify blockers, and set priorities. "
                "Respond with ONLY valid JSON: "
                '{"summary": "...", "decisions": ["..."], "blockers": ["..."], "next_priorities": ["..."]}'
            ),
        )

        try:
            result = await standup_agent.run(
                f"Company: {startup_context['name']}\n"
                f"Team status:\n{json.dumps(agent_statuses, indent=2)}"
            )
            raw = str(result.output)
            start = raw.find("{")
            end = raw.rfind("}") + 1
            if start >= 0 and end > start:
                minutes = json.loads(raw[start:end])
            else:
                minutes = {"summary": raw, "decisions": [], "blockers": [], "next_priorities": []}

        except Exception:
            logger.exception("Standup failed for %s", startup_id)
            minutes = {"summary": "Standup failed to run", "decisions": [], "blockers": [], "next_priorities": []}

        # Persist meeting record
        meeting = Meeting(
            startup_id=startup_id,
            meeting_type=MeetingType.STANDUP,
            status=MeetingStatus.COMPLETED,
            participant_ids=[a.id for a in agents],
            agenda={"type": "standup", "agent_statuses": agent_statuses},
            decisions=minutes.get("decisions", []),
            learnings=minutes.get("next_priorities", []),
            raw_transcript=json.dumps(minutes),
        )
        session.add(meeting)

        # CEO posts standup summary in chat
        msg = ChatMessage(
            startup_id=startup_id,
            role="assistant",
            content=(
                f"**Standup Meeting**\n\n{minutes.get('summary', 'No summary')}\n\n"
                + (f"**Decisions:** {', '.join(minutes.get('decisions', []))}\n\n" if minutes.get('decisions') else "")
                + (f"**Blockers:** {', '.join(minutes.get('blockers', []))}\n\n" if minutes.get('blockers') else "")
                + (f"**Next Priorities:** {', '.join(minutes.get('next_priorities', []))}" if minutes.get('next_priorities') else "")
            ),
        )
        session.add(msg)

        await session.flush()
        logger.info("Standup completed for %s", startup_id)

        await self._broadcast(startup_id, "meeting_completed", {
            "meeting_type": "standup",
            "summary": minutes.get("summary", ""),
        })
