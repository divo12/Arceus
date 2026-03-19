"""Agent (Employee) routes."""

from fastapi import APIRouter, Depends

from arceus.api.deps import get_agent_repo
from arceus.api.schemas.agent import AgentResponse
from arceus.db.repos import AgentRepo

router = APIRouter(prefix="/startups/{startup_id}/agents", tags=["agents"])


@router.get("", response_model=list[AgentResponse])
async def list_agents(
    startup_id: str,
    include_spawned: bool = False,
    repo: AgentRepo = Depends(get_agent_repo),
) -> list[AgentResponse]:
    agents = await repo.list_for_startup(startup_id, include_spawned)
    return [AgentResponse.model_validate(a, from_attributes=True) for a in agents]


@router.get("/{agent_id}", response_model=AgentResponse)
async def get_agent(
    startup_id: str,
    agent_id: str,
    repo: AgentRepo = Depends(get_agent_repo),
) -> AgentResponse:
    agent = await repo.get(agent_id)
    if not agent:
        from fastapi import HTTPException
        raise HTTPException(404, "Agent not found")
    return AgentResponse.model_validate(agent, from_attributes=True)


@router.get("/{agent_id}/metrics")
async def get_agent_metrics(startup_id: str, agent_id: str) -> dict:
    return {"agent_id": agent_id, "tasks_completed": 0, "total_cost": 0}


@router.get("/{agent_id}/memory")
async def get_agent_memory(startup_id: str, agent_id: str) -> dict:
    return {"agent_id": agent_id, "patterns": [], "skills": []}


@router.get("/{agent_id}/tasks")
async def get_agent_tasks(startup_id: str, agent_id: str) -> list:
    return []
