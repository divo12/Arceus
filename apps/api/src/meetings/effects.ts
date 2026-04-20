import type { AgentIdentity, Task } from "@arceus/contracts";
import { getAgentByRole, uniqueStrings } from "@arceus/task-engine";
import { getSnapshot, updateTask } from "../persistence/store.js";
import { audit } from "../observability/audit-ledger.js";
import { enrichRoleMemory, clearRoleBlockers } from "../memory/operations.js";
import { emitReactive } from "../orchestration/reactive.js";
import type { TaskModificationInput, MemoryModificationInput, MeetingAgendaInput, MeetingDecisionInput, MeetingLearningInput } from "../orchestration/state.js";

/** Apply a single task modification (assign, cancel, unblock, etc.) to the store and emit audit/reactive events. */
export function applyTaskModification(modification: TaskModificationInput) {
  updateTask(modification.taskId, (task) => {
    const assignedAgent = modification.assignedRole ? getAgentByRole(getSnapshot(), modification.assignedRole) : null;
    const nextStatus =
      modification.resultingStatus ??
      (modification.modificationType === "assign"
        ? task.status === "created"
          ? "planned"
          : task.status
        : modification.modificationType === "cancel"
          ? "cancelled"
          : modification.modificationType === "unblock" && task.status === "blocked"
            ? "planned"
            : task.status);

    const nextTask: Task = {
      ...task,
      status: nextStatus,
      assignedRole: modification.assignedRole ?? task.assignedRole,
      assignedAgentId: modification.assignedRole ? assignedAgent?.id ?? null : task.assignedAgentId,
      priority: modification.priority ?? task.priority,
      plannerState:
        modification.modificationType === "decompose_further"
          ? {
              ...task.plannerState,
              planSteps: uniqueStrings([...task.plannerState.planSteps, modification.details], 12),
            }
          : task.plannerState,
      executorState: {
        ...task.executorState,
        results: [...task.executorState.results, `meeting:${modification.modificationType}:${modification.details}`].slice(-50),
      },
      verifierState:
        modification.modificationType === "cancel"
          ? {
              ...task.verifierState,
              feedback: modification.details,
            }
          : task.verifierState,
    };

    return nextTask;
  });

  if (modification.modificationType === "assign" || modification.modificationType === "reassign") {
    const companyId = getSnapshot().company.id;
    audit({
      companyId,
      category: "task_lifecycle",
      eventType: "task_assigned",
      summary: `Task "${modification.taskId}" ${modification.modificationType} → ${modification.assignedRole ?? "unassigned"}`,
      detail: {
        taskId: modification.taskId,
        modificationType: modification.modificationType,
        assignedRole: modification.assignedRole ?? null,
        details: modification.details,
      },
      correlationId: modification.taskId,
    });
    if (modification.assignedRole) {
      emitReactive(modification.assignedRole, "task_assigned");
    }
  } else if (modification.modificationType === "cancel") {
    const companyId = getSnapshot().company.id;
    audit({
      companyId,
      category: "task_lifecycle",
      severity: "warn",
      eventType: "task_cancelled",
      summary: `Task "${modification.taskId}" cancelled: ${modification.details.slice(0, 100)}`,
      detail: { taskId: modification.taskId, reason: modification.details },
      correlationId: modification.taskId,
    });
  }
}

function applyMemoryModification(modification: MemoryModificationInput) {
  switch (modification.modificationType) {
    case "current_focus":
      enrichRoleMemory(modification.role, { currentFocus: [modification.content] });
      break;
    case "recent_learning":
      enrichRoleMemory(modification.role, { recentLearnings: [modification.content] });
      break;
    case "active_pattern":
      enrichRoleMemory(modification.role, { activePatterns: [modification.content] });
      break;
    case "open_blocker":
      enrichRoleMemory(modification.role, { openBlockers: [modification.content] });
      break;
    case "important_decision":
      enrichRoleMemory(modification.role, { importantDecisions: [modification.content] });
      break;
    case "clear_blocker":
      clearRoleBlockers(modification.role, [modification.content]);
      break;
  }
}

/**
 * Derive deduplicated memory modifications from meeting agenda, decisions, learnings,
 * and task unblock actions.
 */
export function deriveMeetingMemoryModifications(params: {
  agenda: MeetingAgendaInput[];
  decisions?: MeetingDecisionInput[];
  learnings?: MeetingLearningInput[];
  participantRoles: AgentIdentity["role"][];
  memoryModifications?: MemoryModificationInput[];
  taskModifications?: TaskModificationInput[];
}) {
  const clearBlockerModifications = (params.taskModifications ?? [])
    .filter((modification) => modification.modificationType === "unblock")
    .flatMap((modification) => {
      const task = getSnapshot().tasks.find((entry) => entry.id === modification.taskId);
      return task
        ? [
            {
              role: task.assignedRole,
              modificationType: "clear_blocker" as const,
              content: modification.details,
            },
          ]
        : [];
    });

  const derived: MemoryModificationInput[] = [
    ...(params.memoryModifications ?? []),
    ...params.agenda
      .filter((agenda) => agenda.type === "blocker")
      .map((agenda) => ({
        role: agenda.raisedByRole,
        modificationType: "open_blocker" as const,
        content: agenda.content,
      })),
    ...(params.decisions ?? []).flatMap((decision) =>
      decision.decidedByRoles.map((role) => ({
        role,
        modificationType: "important_decision" as const,
        content: decision.description,
      })),
    ),
    ...(params.learnings ?? []).map((learning) => ({
      role: learning.role,
      modificationType: "recent_learning" as const,
      content: learning.content,
    })),
    ...params.participantRoles.map((role) => ({
      role,
      modificationType: "active_pattern" as const,
      content: `Meeting cadence: ${params.taskModifications?.length ? "action-oriented" : "communication-only"} ${params.participantRoles.length}-party ${params.agenda.length > 0 ? "meeting" : "sync"}`,
    })),
    ...clearBlockerModifications,
  ];

  const seen = new Set<string>();
  return derived.filter((item) => {
    const key = `${item.role}:${item.modificationType}:${item.content}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Apply all task and memory modifications produced by a meeting. */
export function applyMeetingEffects(taskModifications: TaskModificationInput[], memoryModifications: MemoryModificationInput[]) {
  for (const modification of taskModifications) {
    applyTaskModification(modification);
  }
  for (const modification of memoryModifications) {
    applyMemoryModification(modification);
  }
}
