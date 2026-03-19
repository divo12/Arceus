"""AgentExecutor — runs an employee agent on a task and produces structured output.

Each call:
1. Builds a PydanticAI Agent from the employee's role + system prompt
2. Injects meeting-sourced memory into context
3. Forces structured output via result_type=AgentOutput (union)
4. Persists Deliverable + TraceEntry + CostEntry
5. Updates task status
"""

from __future__ import annotations

import json
import logging
from typing import Any

from pydantic_ai import Agent
from sqlalchemy.ext.asyncio import AsyncSession

from arceus.config.settings import settings
from arceus.core.agents.model_factory import build_model
from arceus.core.roles import ROLE_CATALOG
from arceus.core.schemas.deliverables import (
    AgentOutput,
    DeliverableType,
    TaskDecomposition,
)
from arceus.db.models.agent import Agent as AgentModel, AgentStatus
from arceus.db.models.budget import CostEntry
from arceus.db.models.deliverable import Deliverable
from arceus.db.models.task import Task, TaskStatus, TraceEntry

logger = logging.getLogger(__name__)

# Approximate pricing per 1M tokens (input/output) for cost tracking
MODEL_PRICING: dict[str, tuple[float, float]] = {
    "gpt-5": (2.00, 8.00),
    "gpt-5.1-chat": (2.00, 8.00),
    "gpt-4.1-mini": (0.40, 1.60),
    "gpt-4.1-nano": (0.10, 0.40),
}


def _estimate_cost(model: str, tokens_in: int, tokens_out: int) -> float:
    """Estimate cost from token counts."""
    price_in, price_out = MODEL_PRICING.get(model, (2.00, 8.00))
    return (tokens_in * price_in + tokens_out * price_out) / 1_000_000


def _build_employee_prompt(
    agent_row: AgentModel,
    task: Task,
    startup_context: dict[str, Any],
) -> str:
    """Build the full system prompt for an employee agent."""
    role_info = ROLE_CATALOG.get(agent_row.role)
    base_prompt = agent_row.system_prompt or (role_info.system_prompt if role_info else f"You are the {agent_row.role}.")

    # Inject meeting-sourced memory
    memory_block = ""
    if agent_row.agent_memory:
        memory_items = agent_row.agent_memory[-20:]  # Last 20 memory items
        memory_block = "\n\n--- KNOWLEDGE FROM MEETINGS ---\n"
        for item in memory_items:
            memory_block += f"- {item}\n"

    prompt = f"""{base_prompt}

--- STARTUP CONTEXT ---
Company: {startup_context.get('name', 'Unknown')}
Core Idea: {startup_context.get('core_idea', '')}
Current Direction: {startup_context.get('current_direction', '')}
Budget: ${startup_context.get('budget_allocated', 0):.2f} allocated, ${startup_context.get('budget_spent', 0):.2f} spent
{memory_block}
--- YOUR TASK ---
Title: {task.title}
Description: {task.description or 'No description provided'}
Priority: {task.priority}

--- INSTRUCTIONS ---
Analyze this task and produce the most appropriate structured output.
Choose the output TYPE that best matches what this task requires:

- "task_decomposition" — if this task is too complex and should be broken into sub-tasks assigned to other roles
- "technical_spec" — if you need to define system architecture, components, and technical decisions
- "api_design" — if you need to design API endpoints with request/response schemas
- "data_model" — if you need to design database models, tables, and relationships
- "ui_spec" — if you need to design user interfaces, screens, and interactions
- "research_report" — if you need to research a topic and report findings

Pick ONE type and produce a complete, thorough output. Be specific and actionable — another agent will use your output to do their work.
"""
    return prompt


class AgentExecutor:
    """Runs employee agents on tasks, producing structured deliverables."""

    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def execute(
        self,
        agent_row: AgentModel,
        task: Task,
        startup_context: dict[str, Any],
    ) -> Deliverable | None:
        """Execute an employee agent on a task.

        Returns the created Deliverable, or None if execution failed.
        """
        # Mark agent as running
        agent_row.status = AgentStatus.RUNNING
        task.status = TaskStatus.IN_PROGRESS
        await self.session.flush()

        system_prompt = _build_employee_prompt(agent_row, task, startup_context)

        # Determine model tier based on agent level
        if agent_row.role == "CEO":
            model_name = settings.model_ceo
        elif agent_row.level <= 1:
            model_name = settings.model_employee
        else:
            model_name = settings.model_employee

        model = build_model(model_name)

        agent = Agent(
            model=model,
            system_prompt=system_prompt,
            output_type=AgentOutput,  # type: ignore[arg-type]
        )

        try:
            result = await agent.run(
                f"Execute this task: {task.title}\n\n{task.description or ''}"
            )
            output: AgentOutput = result.output  # type: ignore[assignment]

            # Extract token usage for cost tracking
            tokens_in = 0
            tokens_out = 0
            try:
                usage = result.usage()
                tokens_in = usage.request_tokens or 0
                tokens_out = usage.response_tokens or 0
            except Exception:
                pass

            cost = _estimate_cost(model_name, tokens_in, tokens_out)

            # Persist deliverable
            deliverable = Deliverable(
                startup_id=task.startup_id,
                task_id=task.id,
                agent_id=agent_row.id,
                deliverable_type=output.type,
                content=output.model_dump(),
                status="draft",
            )
            self.session.add(deliverable)

            # Update task
            task.execution_state = output.model_dump()
            task.status = TaskStatus.COMPLETED
            task.cost = float(cost)

            # Record trace entry
            trace = TraceEntry(
                task_id=task.id,
                agent_id=agent_row.id,
                entry_type="llm_response",
                content=json.dumps({
                    "output_type": output.type,
                    "summary": output.summary,
                    "model": model_name,
                    "tokens_in": tokens_in,
                    "tokens_out": tokens_out,
                }),
                metadata_={
                    "model": model_name,
                    "cost": cost,
                    "deliverable_type": output.type,
                },
            )
            self.session.add(trace)

            # Record cost
            cost_entry = CostEntry(
                startup_id=task.startup_id,
                agent_id=agent_row.id,
                task_id=task.id,
                model=model_name,
                tokens_in=tokens_in,
                tokens_out=tokens_out,
                cost=cost,
            )
            self.session.add(cost_entry)

            # Update agent metrics
            agent_row.status = AgentStatus.IDLE
            agent_row.total_tasks_completed += 1
            agent_row.total_cost = float(agent_row.total_cost) + cost

            # Update startup budget
            from arceus.db.models.startup import Startup
            startup = await self.session.get(Startup, task.startup_id)
            if startup:
                startup.budget_spent = float(startup.budget_spent) + cost

            await self.session.flush()

            logger.info(
                "Agent %s (%s) completed task '%s' → %s deliverable (cost: $%.4f)",
                agent_row.id, agent_row.role, task.title, output.type, cost,
            )
            return deliverable

        except Exception as e:
            logger.exception(
                "Agent %s (%s) failed on task '%s': %s",
                agent_row.id, agent_row.role, task.title, e,
            )
            task.status = TaskStatus.FAILED
            task.outcome = f"Execution failed: {e}"
            agent_row.status = AgentStatus.IDLE

            # Record failure trace
            trace = TraceEntry(
                task_id=task.id,
                agent_id=agent_row.id,
                entry_type="error",
                content=str(e),
            )
            self.session.add(trace)
            await self.session.flush()
            return None
