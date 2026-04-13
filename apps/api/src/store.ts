import type {
  Approval,
  AgentIdentity,
  ChatMessage,
  CompanySnapshot,
  EventEnvelope,
  FeedbackRound,
  HierarchyNode,
  Meeting,
  MemorySummary,
  SessionBinding,
  Sprint,
  Task,
  Transition
} from "@arceus/contracts";
import { assertRoleHierarchy, createBootstrapEvent, createEmptyCompanySnapshot, getRoleSoul } from "@arceus/company-runtime";
import type { StrategyOutput } from "./ceo";
import { deletePersistedCompanyState, flushPersistedCompanyState, loadPersistedCompanyState, schedulePersistedCompanyState } from "./company-state";
import { cpNotifyStateChange } from "./control-plane";

type BootstrapInput = {
  companyName: string;
  boardOwner: string;
  idea: string;
  budgetCents: number;
};

let snapshot = createEmptyCompanySnapshot();
let events: EventEnvelope[] = [];

function persistState() {
  void schedulePersistedCompanyState(snapshot, events).catch((error) => {
    console.warn("[store] Failed to persist company state", error);
  });
}

function replaceState(nextSnapshot: CompanySnapshot, nextEvents = events) {
  snapshot = nextSnapshot;
  events = nextEvents;
  persistState();
  cpNotifyStateChange();
  return snapshot;
}

function titleCase(value: string) {
  return value
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function deriveCompanyNameFromIdea(idea: string) {
  const core = idea
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .join(" ");

  return core ? `${titleCase(core)} Labs` : "New Company";
}

function buildAgentName(role: string) {
  if (role === "ceo") return "Avery";
  if (role === "cto") return "Lin";
  if (role === "pm") return "Mina";
  if (role === "developer") return "Jules";
  if (role === "tester") return "Quinn";
  if (role === "ui_designer") return "Sage";
  if (role === "marketing") return "Parker";
  if (role === "skills_lead") return "Rowan";
  return titleCase(role.replace(/_/g, " "));
}

export function getSnapshot() {
  return snapshot;
}

export function getEvents() {
  return events;
}

export function resetCompany() {
  snapshot = createEmptyCompanySnapshot();
  events = [];
  return snapshot;
}

export async function hydrateStoreFromPersistence() {
  const persisted = await loadPersistedCompanyState();
  if (!persisted) {
    return false;
  }

  snapshot = persisted.snapshot;
  events = persisted.events;
  return true;
}

export async function clearPersistedStoreState(companyId: string) {
  await deletePersistedCompanyState(companyId);
}

export async function flushStorePersistence() {
  await flushPersistedCompanyState();
}

export function appendChatMessage(message: ChatMessage) {
  replaceState({
    ...snapshot,
    chatMessages: [...snapshot.chatMessages, message],
  });

  return message;
}

export function replaceTasks(tasks: Task[]) {
  replaceState({
    ...snapshot,
    tasks,
  });
  return snapshot.tasks;
}

export function upsertTask(task: Task) {
  const existing = snapshot.tasks.findIndex((entry) => entry.id === task.id);
  const nextTasks = [...snapshot.tasks];

  if (existing >= 0) {
    nextTasks[existing] = task;
  } else {
    nextTasks.push(task);
  }

  replaceState({
    ...snapshot,
    tasks: nextTasks,
  });

  return task;
}

export function updateTask(taskId: string, updater: (task: Task) => Task) {
  const current = snapshot.tasks.find((task) => task.id === taskId);
  if (!current) return null;

  const next = updater(current);
  upsertTask(next);
  return next;
}

export function upsertSprint(sprint: Sprint) {
  const existing = snapshot.sprints.findIndex((entry) => entry.id === sprint.id);
  const nextSprints = [...snapshot.sprints];

  if (existing >= 0) {
    nextSprints[existing] = sprint;
  } else {
    nextSprints.push(sprint);
  }

  replaceState({
    ...snapshot,
    sprints: nextSprints,
  });

  return sprint;
}

export function updateSprint(sprintId: string, updater: (sprint: Sprint) => Sprint) {
  const current = snapshot.sprints.find((sprint) => sprint.id === sprintId);
  if (!current) return null;

  const next = updater(current);
  upsertSprint(next);
  return next;
}

export function updateCompanySprint(sprintId: string | null, sprintNumber: number | null) {
  replaceState({
    ...snapshot,
    company: {
      ...snapshot.company,
      currentSprintId: sprintId,
      currentSprintNumber: sprintNumber,
    },
  });
}

export function upsertMeeting(meeting: Meeting) {
  const existing = snapshot.meetings.findIndex((entry) => entry.id === meeting.id);
  const nextMeetings = [...snapshot.meetings];

  if (existing >= 0) {
    nextMeetings[existing] = meeting;
  } else {
    nextMeetings.unshift(meeting);
  }

  replaceState({
    ...snapshot,
    meetings: nextMeetings,
  });

  return meeting;
}

export function upsertApproval(approval: Approval) {
  const existing = snapshot.approvals.findIndex((entry) => entry.id === approval.id);
  const nextApprovals = [...snapshot.approvals];

  if (existing >= 0) {
    nextApprovals[existing] = approval;
  } else {
    nextApprovals.unshift(approval);
  }

  replaceState({
    ...snapshot,
    approvals: nextApprovals,
  });

  return approval;
}

export function updateApproval(approvalId: string, updater: (approval: Approval) => Approval) {
  const current = snapshot.approvals.find((approval) => approval.id === approvalId);
  if (!current) return null;

  const next = updater(current);
  upsertApproval(next);
  return next;
}

export function updateMeeting(meetingId: string, updater: (meeting: Meeting) => Meeting) {
  const current = snapshot.meetings.find((meeting) => meeting.id === meetingId);
  if (!current) return null;

  const next = updater(current);
  upsertMeeting(next);
  return next;
}

export function updateAgentMemory(agentId: string, updater: (memory: MemorySummary) => MemorySummary) {
  const memories = snapshot.memories.map((memory) => (memory.agentId === agentId ? updater(memory) : memory));
  replaceState({
    ...snapshot,
    memories,
  });
  return snapshot.memories.find((memory) => memory.agentId === agentId) ?? null;
}

export function appendTransition(transition: Transition) {
  replaceState({
    ...snapshot,
    transitions: [...(snapshot.transitions ?? []), transition],
  });
  return transition;
}

export function updateTransition(transitionId: string, updater: (t: Transition) => Transition) {
  const transitions = (snapshot.transitions ?? []).map((t) => (t.id === transitionId ? updater(t) : t));
  replaceState({ ...snapshot, transitions });
  return transitions.find((t) => t.id === transitionId) ?? null;
}

export function appendFeedbackRound(round: FeedbackRound) {
  replaceState({
    ...snapshot,
    feedbackRounds: [...(snapshot.feedbackRounds ?? []), round],
  });
  return round;
}

export function bootstrapCompany(input: BootstrapInput) {
  const companyId = `company_${crypto.randomUUID()}`;
  const now = new Date().toISOString();

  replaceState({
    ...createEmptyCompanySnapshot(),
    company: {
      ...createEmptyCompanySnapshot().company,
      id: companyId,
      name: input.companyName,
      boardOwner: input.boardOwner,
      goal: input.idea,
      budgetCents: input.budgetCents,
      currentStrategyId: `strategy_${crypto.randomUUID()}`,
      createdAt: now
    },
    idea: {
      id: `idea_${crypto.randomUUID()}`,
      companyId,
      coreIdea: input.idea,
      currentDirection: "",
      refinedWithBoard: false
    },
    strategy: {
      ...createEmptyCompanySnapshot().strategy,
      id: `strategy_${crypto.randomUUID()}`,
      companyId,
      createdAt: now
    }
  }, [
    createBootstrapEvent("Board bootstrapped a new company.", {
      companyId,
      companyName: input.companyName,
      budgetCents: input.budgetCents
    })
  ]);

  return snapshot;
}

export function applyStrategy(output: StrategyOutput) {
  assertRoleHierarchy(output.roles);
  const roleToAgentId = new Map<string, string>();

  const hierarchy: HierarchyNode[] = output.roles.map((role, index) => {
    const nodeId = `node_${crypto.randomUUID()}`;
    const agentId = `agent_${role.role}_${crypto.randomUUID()}`;
    roleToAgentId.set(role.role, agentId);

    return {
      id: nodeId,
      role: role.role as HierarchyNode["role"],
      title: role.title,
      level: 0,
      parentNodeId: null,
      agentId,
      directReportNodeIds: [],
      openForHiring: false
    };
  });

  const nodeByRole = new Map(hierarchy.map((node) => [node.role, node]));

  output.roles.forEach((role) => {
    const node = nodeByRole.get(role.role as HierarchyNode["role"]);
    if (!node) return;
    if (role.parent_role) {
      const parent = nodeByRole.get(role.parent_role as HierarchyNode["role"]);
      node.parentNodeId = parent?.id ?? null;
      if (parent) {
        parent.directReportNodeIds.push(node.id);
      }
    }
  });

  const hierarchyLevelCache = new Map<HierarchyNode["role"], number>();
  const computeNodeLevel = (node: HierarchyNode): number => {
    const cached = hierarchyLevelCache.get(node.role);
    if (cached !== undefined) return cached;
    if (!node.parentNodeId) {
      hierarchyLevelCache.set(node.role, 0);
      return 0;
    }

    const parent = hierarchy.find((candidate) => candidate.id === node.parentNodeId);
    const level = parent ? computeNodeLevel(parent) + 1 : 0;
    hierarchyLevelCache.set(node.role, level);
    return level;
  };

  hierarchy.forEach((node) => {
    node.level = computeNodeLevel(node);
  });

  const agents: AgentIdentity[] = output.roles.map((role) => {
    const node = nodeByRole.get(role.role as HierarchyNode["role"])!;
    const managerAgentId = role.parent_role ? roleToAgentId.get(role.parent_role) ?? null : null;
    const reportAgentIds = output.roles
      .filter((candidate) => candidate.parent_role === role.role)
      .map((candidate) => roleToAgentId.get(candidate.role) ?? "")
      .filter(Boolean);

    return {
      id: node.agentId!,
      companyId: snapshot.company.id,
      nodeId: node.id,
      name: buildAgentName(role.role),
      role: role.role as AgentIdentity["role"],
      title: role.title,
      managerAgentId,
      reportAgentIds,
      capabilities: role.capabilities,
      profile: `${role.title} for ${snapshot.company.name}`,
      soul: getRoleSoul(role.role as AgentIdentity["role"]),
      status: role.role === "ceo" ? "running" : "active",
      sessionBindingId: `session_${crypto.randomUUID()}`,
      memorySummaryId: `memory_${crypto.randomUUID()}`,
      lastHeartbeatAt: null
    };
  });

  const sessions: SessionBinding[] = agents.map((agent) => ({
    id: agent.sessionBindingId,
    agentId: agent.id,
    runtime: "opencode",
    sessionId: "pending-runtime-binding",
    runtimeStatus: "idle",
    model: agent.role === "ceo" ? "azure/ceo-deployment" : "azure/worker-deployment",
    lastSeenAt: new Date().toISOString()
  }));

  const memories: MemorySummary[] = agents.map((agent) => ({
    id: agent.memorySummaryId,
    agentId: agent.id,
    currentFocus: [],
    recentLearnings: [],
    activePatterns: [],
    openBlockers: [],
    importantDecisions: [],
    updatedAt: new Date().toISOString()
  }));

  replaceState({
    ...snapshot,
    company: {
      ...snapshot.company,
      status: "active"
    },
    idea: {
      ...snapshot.idea,
      currentDirection: output.first_release,
      refinedWithBoard: true
    },
    strategy: {
      ...snapshot.strategy,
      title: output.strategy_title,
      summary: output.summary,
      firstRelease: output.first_release,
      scopeBoundary: output.scope_boundary,
      roleRationale: output.role_rationale,
      status: "pending_board_approval"
    },
    hierarchy,
    agents,
    sessions,
    memories
  }, [
    ...events,
    {
      eventId: crypto.randomUUID(),
      companyId: snapshot.company.id,
      entityType: "strategy",
      entityId: snapshot.strategy.id,
      eventType: "strategy.proposed",
      causationId: null,
      correlationId: crypto.randomUUID(),
      actorType: "agent",
      actorId: agents.find((agent) => agent.role === "ceo")?.id ?? "agent_ceo",
      occurredAt: new Date().toISOString(),
      summary: "CEO proposed the first real strategy and org chart.",
      payload: {
        firstRelease: output.first_release,
        roles: output.roles
      }
    }
  ]);

  return snapshot;
}
