import crypto from "node:crypto";
import type {
  Task,
  PlannerState,
  ExecutorState,
  VerifierState,
  CompanySnapshot,
  AgentIdentity,
  Sprint,
} from "@arceus/contracts";

/** ISO-8601 timestamp of the current moment. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Deduplicate and trim a list of nullable strings, capped at `limit`. */
export function uniqueStrings(values: Array<string | null | undefined>, limit = 8): string[] {
  return Array.from(
    new Set(values.filter((value): value is string => Boolean(value && value.trim()))),
  ).slice(0, limit);
}

/** Find an agent by role within a snapshot. */
export function getAgentByRole(
  snapshot: CompanySnapshot,
  role: AgentIdentity["role"],
): AgentIdentity | null {
  return snapshot.agents.find((agent) => agent.role === role) ?? null;
}

/** Create an empty planner state with the given objective. */
export function emptyPlannerState(objective: string): PlannerState {
  return {
    objective,
    planSteps: [],
    selectedTools: [],
    currentStepIndex: 0,
  };
}

/** Create a blank executor state (no commands run). */
export function emptyExecutorState(): ExecutorState {
  return {
    currentCommand: null,
    commandsExecuted: [],
    results: [],
  };
}

/** Create a blank verifier state (unverified, no feedback). */
export function emptyVerifierState(): VerifierState {
  return {
    isVerified: false,
    feedback: null,
    verifiedByAgentId: null,
  };
}

/**
 * Create a new Task object. Pure factory — does not persist.
 */
export function createWorkflowTask(
  snapshot: CompanySnapshot,
  kind: Task["kind"],
  role: AgentIdentity["role"],
  title: string,
  description: string,
  problemStatement: string,
  deliverable: string,
  definitionOfDone: string[],
  priority: Task["priority"],
  status: Task["status"],
  sprintId?: string | null,
): Task {
  const agent = getAgentByRole(snapshot, role);

  return {
    id: `task_${crypto.randomUUID()}`,
    companyId: snapshot.company.id,
    sprintId: sprintId ?? snapshot.company.currentSprintId ?? null,
    kind,
    title,
    description,
    problemStatement,
    deliverable,
    definitionOfDone,
    status,
    priority,
    assignedRole: role,
    assignedAgentId: agent?.id ?? null,
    parentTaskId: null,
    dependsOnTaskIds: [],
    childTaskIds: [],
    artifactIds: [],
    localPreviewUrl: null,
    plannerState: emptyPlannerState(problemStatement),
    executorState: emptyExecutorState(),
    verifierState: emptyVerifierState(),
    costCents: 0,
    iterationCount: 0,
    maxIterations: 3,
    incomingArtifactIds: [],
  };
}

/** Link a child task to its parent (mutates store via callback). */
export function attachChildTask(
  updateTask: (id: string, updater: (t: Task) => Task) => void,
  parentTaskId: string,
  childTaskId: string,
): void {
  updateTask(parentTaskId, (task) => ({
    ...task,
    childTaskIds: task.childTaskIds.includes(childTaskId)
      ? task.childTaskIds
      : [...task.childTaskIds, childTaskId],
  }));
}

/** Check whether all of a task's dependencies are completed. */
export function isTaskReady(task: Task, snapshot: CompanySnapshot): boolean {
  if (!["created", "planned"].includes(task.status)) return false;

  return task.dependsOnTaskIds.every((dependencyId) => {
    const dependency = snapshot.tasks.find((entry) => entry.id === dependencyId);
    return dependency?.status === "completed";
  });
}

/** Sort weight by priority — lower = higher priority. */
export function taskSortWeight(task: Task): number {
  if (task.priority === "critical") return 0;
  if (task.priority === "high") return 1;
  if (task.priority === "medium") return 2;
  return 3;
}

/** Sort weight for specialist role execution order. */
export function specialistRoleWeight(
  role: AgentIdentity["role"],
  weights: Record<string, number>,
  fallback = 7,
): number {
  return weights[role] ?? fallback;
}

/**
 * Create a new Sprint record. Pure factory — does not persist.
 */
export function createSprintObject(
  snapshot: CompanySnapshot,
  title: string,
  goal: string,
): Sprint {
  const number = (snapshot.company.currentSprintNumber ?? 0) + 1;
  const ceoAgent = getAgentByRole(snapshot, "ceo");
  return {
    id: `sprint_${crypto.randomUUID()}`,
    companyId: snapshot.company.id,
    strategyId: snapshot.company.currentStrategyId,
    number,
    title: title || `Sprint ${number}`,
    goal: goal || "",
    status: "planning",
    plannedByAgentId: ceoAgent?.id ?? null,
    summary: null,
    createdAt: nowIso(),
    startedAt: null,
    completedAt: null,
  };
}
