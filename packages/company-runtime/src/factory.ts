import type { CompanySnapshot, EventEnvelope } from "@arceus/contracts";

function nowIso() {
  return new Date().toISOString();
}

/**
 * Create a blank CompanySnapshot with empty-string placeholder IDs,
 * ready for bootstrap. Spec 31 Phase 7.C.1 — the legacy
 * `"company_pending"` magic string is gone; consumers test for
 * `!snapshot.company.id` (or use `getActiveCompanyId()` which returns
 * null) to detect the pre-bootstrap state.
 */
export function createEmptyCompanySnapshot(): CompanySnapshot {
  const createdAt = nowIso();

  return {
    company: {
      id: "",
      name: "Untitled Company",
      boardOwner: "board_primary",
      goal: "Awaiting board bootstrap.",
      budgetCents: 0,
      spentCents: 0,
      status: "ideation",
      currentStrategyId: "",
      currentSprintId: null,
      currentSprintNumber: null,
      createdAt
    },
    idea: {
      id: "",
      companyId: "",
      coreIdea: "",
      currentDirection: "",
      refinedWithBoard: false
    },
    strategy: {
      id: "",
      companyId: "",
      title: "Awaiting CEO refinement",
      summary: "No strategy has been generated yet.",
      firstRelease: "",
      scopeBoundary: [],
      roleRationale: [],
      status: "draft",
      createdByAgentId: "",
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
  const companyIdFromPayload = typeof payload.companyId === "string" ? payload.companyId : "";
  return {
    eventId: crypto.randomUUID(),
    companyId: companyIdFromPayload,
    entityType: "company",
    entityId: companyIdFromPayload,
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
