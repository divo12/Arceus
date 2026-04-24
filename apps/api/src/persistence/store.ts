import type {
  Approval,
  AgentIdentity,
  ChatMessage,
  CompanySnapshot,
  EventEnvelope,
  FeedbackRound,
  HierarchyNode,
  Meeting,
  MeetingSchedule,
  MemorySummary,
  SessionBinding,
  Sprint,
  Task,
  TaskProgress,
  Transition
} from "@arceus/contracts";
import { assertRoleHierarchy, createBootstrapEvent, createEmptyCompanySnapshot, getRoleSoul, ROLE_DISPLAY_NAMES } from "@arceus/company-runtime";
import type { StrategyOutput } from "../agents/ceo.js";
import { artifacts as runtimeArtifacts, type Artifact as RuntimeArtifact } from "../orchestration/state.js";
import { persistRuntimeArtifact } from "./artifact-persistence.js";
import { deletePersistedCompanyState, flushPersistedCompanyState, loadPersistedCompanyState, schedulePersistedCompanyState } from "./company-state.js";
import { storeEvents } from "./store-events.js";

type BootstrapInput = {
  companyName: string;
  boardOwner: string;
  idea: string;
  budgetCents: number;
};

// ── Cache lifecycle state ──────────────────────────────────
// Phase 4: store.ts is now an explicit read-cache, not the
// source of truth. State is hydrated from DB at startup (or
// beat start in Spec 12), mutated in-memory, and flushed back.

let snapshot = createEmptyCompanySnapshot();
let events: EventEnvelope[] = [];
let dirty = false;
let lastHydratedAt: string | null = null;
let lastFlushedAt: string | null = null;
let mutationsSinceHydrate = 0;

function persistState() {
  void schedulePersistedCompanyState(snapshot, events).catch((error) => {
    console.warn("[store] Failed to persist company state", error);
  });
}

function replaceState(nextSnapshot: CompanySnapshot, nextEvents = events) {
  snapshot = nextSnapshot;
  events = nextEvents;
  dirty = true;
  mutationsSinceHydrate++;
  persistState();
  storeEvents.emit("state-changed");
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

/** Derive a fun, abstract 1-2 word company name from a free-text idea using the LLM. */
export async function deriveCompanyNameFromIdea(idea: string): Promise<string> {
  try {
    const { structuredCompletion } = await import("../infra/azure-openai.js");
    const { z } = await import("zod");
    const schema = z.object({ name: z.string() });
    const result = await structuredCompletion(
      "ceoDeployment",
      [
        {
          role: "system",
          content:
            "Generate a creative, fun, abstract company name (1-2 words). " +
            "It should feel like a startup name — evocative, memorable, slightly playful. " +
            "Do NOT include generic suffixes like Labs, Inc, Co, Corp, etc. " +
            "Return ONLY the name. Examples of good names: Nebula, Helix, Prism, Opal, Zigzag.",
        },
        { role: "user", content: `Business idea: ${idea.slice(0, 200)}` },
      ],
      schema,
      "company_name",
      { temperature: 1.0, maxTokens: 30 },
    );
    const name = result.name?.trim();
    if (name && name.length >= 2 && name.length <= 30) return name;
  } catch {
    // fall through to deterministic fallback
  }
  const core = idea
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .join(" ");
  return core ? titleCase(core) : "New Company";
}

function buildAgentName(role: string) {
  return (ROLE_DISPLAY_NAMES as Record<string, string | undefined>)[role]
    ?? titleCase(role.replace(/_/g, " "));
}

/** Return the current in-memory company snapshot. */
export function getSnapshot() {
  return snapshot;
}

/** Return the current in-memory event log. */
export function getEvents() {
  return events;
}

/** Reset the in-memory company state to a blank snapshot. */
export function resetCompany() {
  snapshot = createEmptyCompanySnapshot();
  events = [];
  dirty = false;
  mutationsSinceHydrate = 0;
  return snapshot;
}

// ── Lifecycle: hydrate / flush / teardown ──────────────────
// These methods form the cache lifecycle that Spec 12 (Heartbeat)
// will call at beat boundaries. Today they're called at server
// startup and shutdown.

/**
 * Hydrate the in-memory cache from persisted DB state.
 * Resets dirty tracking. Returns true if state was loaded.
 */
export async function hydrate(companyId?: string): Promise<boolean> {
  const persisted = await loadPersistedCompanyState(companyId);
  if (!persisted) {
    return false;
  }

  snapshot = persisted.snapshot;
  events = persisted.events;
  dirty = false;
  mutationsSinceHydrate = 0;
  lastHydratedAt = new Date().toISOString();
  return true;
}

/**
 * Flush dirty in-memory state to the DB.
 * No-op if the cache is clean.
 */
export async function flush(): Promise<void> {
  await flushPersistedCompanyState();
  if (dirty) {
    dirty = false;
    lastFlushedAt = new Date().toISOString();
  }
}

/**
 * Teardown: flush pending writes and clear the in-memory cache.
 * Called on graceful shutdown or when releasing a company's resources.
 */
export async function teardown(): Promise<void> {
  await flush();
  snapshot = createEmptyCompanySnapshot();
  events = [];
  dirty = false;
  mutationsSinceHydrate = 0;
  lastHydratedAt = null;
  lastFlushedAt = null;
}

/** Delete persisted state for a company from the DB. */
export async function clearPersistedStoreState(companyId: string) {
  await deletePersistedCompanyState(companyId);
}

/** Get cache lifecycle diagnostics for the Control Plane. */
export function getStoreLifecycleState() {
  return {
    dirty,
    mutationsSinceHydrate,
    lastHydratedAt,
    lastFlushedAt,
    companyId: snapshot.company.id,
    isPending: snapshot.company.id === "company_pending",
  };
}

// ── Legacy aliases (backward compat) ───────────────────────

/** @deprecated Use hydrate() */
export const hydrateStoreFromPersistence = hydrate;

/** @deprecated Use flush() */
export const flushStorePersistence = flush;

/** Append a chat message to the snapshot. */
export function appendChatMessage(message: ChatMessage) {
  replaceState({
    ...snapshot,
    chatMessages: [...snapshot.chatMessages, message],
  });

  return message;
}

/** Replace the entire tasks array in the snapshot. */
export function replaceTasks(tasks: Task[]) {
  replaceState({
    ...snapshot,
    tasks,
  });
  return snapshot.tasks;
}

/** Insert or update a task in the snapshot by ID. */
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

/** Update a task by ID using an updater function. */
export function updateTask(taskId: string, updater: (task: Task) => Task) {
  const current = snapshot.tasks.find((task) => task.id === taskId);
  if (!current) return null;

  const next = updater(current);
  upsertTask(next);
  return next;
}

// ── Task progress (multi-beat tracking) ────────────────────
// taskProgress is stored per-task alongside the snapshot. It
// tracks incremental progress across beats for long-running tasks.

const taskProgressMap = new Map<string, TaskProgress>();

/** Record incremental task progress for multi-beat tracking. */
export function updateTaskProgress(taskId: string, progress: TaskProgress) {
  taskProgressMap.set(taskId, progress);
}

/** Get the recorded progress for a specific task. */
export function getTaskProgress(taskId: string): TaskProgress | null {
  return taskProgressMap.get(taskId) ?? null;
}

/** Get all recorded task progress entries. */
export function getAllTaskProgress(): TaskProgress[] {
  return Array.from(taskProgressMap.values());
}

/** Clear recorded progress for a specific task. */
export function clearTaskProgress(taskId: string) {
  taskProgressMap.delete(taskId);
}

/** Insert or update a sprint in the snapshot by ID. */
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

/** Update a sprint by ID using an updater function. */
export function updateSprint(sprintId: string, updater: (sprint: Sprint) => Sprint) {
  const current = snapshot.sprints.find((sprint) => sprint.id === sprintId);
  if (!current) return null;

  const next = updater(current);
  upsertSprint(next);
  return next;
}

/** Set the active sprint ID and number on the company record. */
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

/** Insert or update a meeting in the snapshot by ID. */
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

/**
 * Spec 26 §3.3 / Spec 28 Phase B.1 — synchronous durable write for meetings.
 * Upserts the meeting in the in-memory snapshot then awaits the persistence
 * queue drain so the snapshot row is in the DB before we return. Use this
 * from any route handler that records or mutates a meeting; on process kill
 * immediately after the call, the meeting must survive restart.
 */
export async function writeMeetingSync(meeting: Meeting): Promise<Meeting> {
  upsertMeeting(meeting);
  await flushPersistedCompanyState();
  return meeting;
}

/**
 * Spec 26 §3.3 / Spec 28 Phase B.1 — synchronous durable write for artifacts.
 * Awaits the per-artifact DB insert FIRST, then updates the in-memory
 * `artifacts` array. Caller is responsible for filesystem materialization
 * (fire-and-forget is fine there — disk is best-effort, DB is the source of truth).
 */
export async function writeArtifactSync(artifact: RuntimeArtifact): Promise<RuntimeArtifact> {
  const companyId = snapshot.company.id;
  await persistRuntimeArtifact(companyId, {
    id: artifact.id,
    agent: artifact.agent,
    kind: artifact.kind,
    title: artifact.title,
    content: artifact.content,
    createdAt: artifact.createdAt,
  });
  if (!runtimeArtifacts.find((a) => a.id === artifact.id)) {
    runtimeArtifacts.push(artifact);
  }
  return artifact;
}

/** Insert or update an approval in the snapshot by ID. */
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

/** Update an approval by ID using an updater function. */
export function updateApproval(approvalId: string, updater: (approval: Approval) => Approval) {
  const current = snapshot.approvals.find((approval) => approval.id === approvalId);
  if (!current) return null;

  const next = updater(current);
  upsertApproval(next);
  return next;
}

/** Update a meeting by ID using an updater function. */
export function updateMeeting(meetingId: string, updater: (meeting: Meeting) => Meeting) {
  const current = snapshot.meetings.find((meeting) => meeting.id === meetingId);
  if (!current) return null;

  const next = updater(current);
  upsertMeeting(next);
  return next;
}

/** Insert or update a meeting schedule in the snapshot by ID. */
export function upsertMeetingSchedule(schedule: MeetingSchedule) {
  const schedules = snapshot.meetingSchedules ?? [];
  const existing = schedules.findIndex((s) => s.id === schedule.id);
  const next = [...schedules];
  if (existing >= 0) {
    next[existing] = schedule;
  } else {
    next.push(schedule);
  }
  replaceState({ ...snapshot, meetingSchedules: next });
  return schedule;
}

/** Update a meeting schedule by ID using an updater function. */
export function updateMeetingSchedule(scheduleId: string, updater: (s: MeetingSchedule) => MeetingSchedule) {
  const schedules = snapshot.meetingSchedules ?? [];
  const current = schedules.find((s) => s.id === scheduleId);
  if (!current) return null;
  const next = updater(current);
  upsertMeetingSchedule(next);
  return next;
}

/** Update an agent's memory summary using an updater function. */
export function updateAgentMemory(agentId: string, updater: (memory: MemorySummary) => MemorySummary) {
  const memories = snapshot.memories.map((memory) => (memory.agentId === agentId ? updater(memory) : memory));
  replaceState({
    ...snapshot,
    memories,
  });
  return snapshot.memories.find((memory) => memory.agentId === agentId) ?? null;
}

/** Append a transition to the snapshot. */
export function appendTransition(transition: Transition) {
  replaceState({
    ...snapshot,
    transitions: [...(snapshot.transitions ?? []), transition],
  });
  return transition;
}

/** Update a transition by ID using an updater function. */
export function updateTransition(transitionId: string, updater: (t: Transition) => Transition) {
  const transitions = (snapshot.transitions ?? []).map((t) => (t.id === transitionId ? updater(t) : t));
  replaceState({ ...snapshot, transitions });
  return transitions.find((t) => t.id === transitionId) ?? null;
}

/** Append a feedback round to the snapshot. */
export function appendFeedbackRound(round: FeedbackRound) {
  replaceState({
    ...snapshot,
    feedbackRounds: [...(snapshot.feedbackRounds ?? []), round],
  });
  return round;
}

// ── Status mutations (Phase 4: wired from control-plane) ───

/** Update an agent's status field by agent ID. */
export function updateAgentStatus(agentId: string, status: string) {
  const agents = snapshot.agents.map((a) =>
    a.id === agentId ? { ...a, status: status as AgentIdentity["status"] } : a,
  );
  replaceState({ ...snapshot, agents });
  return agents.find((a) => a.id === agentId) ?? null;
}

/** Update the company's top-level status. */
export function updateCompanyStatus(status: string) {
  replaceState({
    ...snapshot,
    company: { ...snapshot.company, status: status as CompanySnapshot["company"]["status"] },
  });
}

/** Bootstrap a new company with initial snapshot and event log. */
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

/** Apply a CEO strategy output: build the org hierarchy, agents, sessions, and memories. */
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

  // Eager trust initialization — fire event so control-plane handles it
  // without a circular import. Fire-and-forget; DB writes must not block
  // the HTTP response.
  storeEvents.emit("agents-hired", agents);

  return snapshot;
}
