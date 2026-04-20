import type { CompanySnapshot, EventEnvelope } from "@arceus/contracts";

function nowIso() {
  return new Date().toISOString();
}

/** Create a blank CompanySnapshot with placeholder IDs, ready for bootstrap. */
export function createEmptyCompanySnapshot(): CompanySnapshot {
  const createdAt = nowIso();

  return {
    company: {
      id: "company_pending",
      name: "Untitled Company",
      boardOwner: "board_primary",
      goal: "Awaiting board bootstrap.",
      budgetCents: 0,
      spentCents: 0,
      status: "ideation",
      currentStrategyId: "strategy_pending",
      currentSprintId: null,
      currentSprintNumber: null,
      createdAt
    },
    idea: {
      id: "idea_pending",
      companyId: "company_pending",
      coreIdea: "",
      currentDirection: "",
      refinedWithBoard: false
    },
    strategy: {
      id: "strategy_pending",
      companyId: "company_pending",
      title: "Awaiting CEO refinement",
      summary: "No strategy has been generated yet.",
      firstRelease: "",
      scopeBoundary: [],
      roleRationale: [],
      status: "draft",
      createdByAgentId: "agent_ceo",
      createdAt
    },
    sprints: [],
    hierarchy: [],
    agents: [],
    sessions: [],
    tasks: [],
    artifacts: [],
    chatMessages: [],
    meetings: [],
    meetingSchedules: [],
    approvals: [],
    memories: [],
    memoryUnits: [],
    habits: [],
    priming: [],
    transitions: [],
    feedbackRounds: []
  };
}

/** Create an EventEnvelope for a bootstrap-phase mutation (actor = board). */
export function createBootstrapEvent(summary: string, payload: Record<string, unknown>): EventEnvelope {
  return {
    eventId: crypto.randomUUID(),
    companyId: typeof payload.companyId === "string" ? payload.companyId : "company_pending",
    entityType: "company",
    entityId: typeof payload.companyId === "string" ? payload.companyId : "company_pending",
    eventType: "company.updated",
    causationId: null,
    correlationId: crypto.randomUUID(),
    actorType: "board",
    actorId: "board_primary",
    occurredAt: nowIso(),
    summary,
    payload
  };
}
