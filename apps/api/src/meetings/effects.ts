import type { AgentIdentity, Task } from "@arceus/contracts";
import { uniqueStrings } from "@arceus/task-engine";
import { updateTask } from "../persistence/mutations/index.js";
import { getDb } from "@arceus/db";
import * as agentsRepo from "@arceus/db/src/repos/agents.js";
import * as tasksRepo from "@arceus/db/src/repos/tasks/index.js";
import { audit } from "../observability/audit-ledger.js";
import { swallowAndAudit } from "../observability/swallow.js";
import { enrichRoleMemory, clearRoleBlockers } from "../memory/operations.js";
import { emitReactive } from "../orchestration/reactive.js";
import type { TaskModificationInput, MemoryModificationInput, MeetingAgendaInput, MeetingDecisionInput, MeetingLearningInput } from "../orchestration/state.js";

/**
 * Apply a single task modification (assign, cancel, unblock, etc.) to
 * the store and emit audit/reactive events. Spec 31 Phase 7.B.2 —
 * `companyId` and the resolved-agent map come pre-populated from
 * `applyMeetingEffects` so this function can stay sync inside the
 * `updateTask` updater closure.
 */
function applyTaskModification(
  companyId: string,
  modification: TaskModificationInput,
  agentByRole: Map<AgentIdentity["role"], { id: string }>,
): void {
  swallowAndAudit("meeting.apply_task_modification", () => updateTask(modification.taskId, (task) => {
    const assignedAgent = modification.assignedRole ? agentByRole.get(modification.assignedRole) ?? null : null;
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
  }), { companyId, detail: { taskId: modification.taskId, modificationType: modification.modificationType } });

  if (modification.modificationType === "assign" || modification.modificationType === "reassign") {
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

async function applyMemoryModification(companyId: string, modification: MemoryModificationInput): Promise<void> {
  switch (modification.modificationType) {
    case "current_focus":
      await enrichRoleMemory(companyId, modification.role, { currentFocus: [modification.content] });
      break;
    case "recent_learning":
      await enrichRoleMemory(companyId, modification.role, { recentLearnings: [modification.content] });
      break;
    case "active_pattern":
      await enrichRoleMemory(companyId, modification.role, { activePatterns: [modification.content] });
      break;
    case "open_blocker":
      await enrichRoleMemory(companyId, modification.role, { openBlockers: [modification.content] });
      break;
    case "important_decision":
      await enrichRoleMemory(companyId, modification.role, { importantDecisions: [modification.content] });
      break;
    case "clear_blocker":
      await clearRoleBlockers(companyId, modification.role, [modification.content]);
      break;
  }
}

/**
 * Derive deduplicated memory modifications from meeting agenda,
 * decisions, learnings, and task unblock actions. Spec 31 Phase 7.B.2 —
 * the unblock-task lookup now resolves through `tasksRepo`; the
 * function becomes async because of that one read.
 */
export async function deriveMeetingMemoryModifications(params: {
  agenda: MeetingAgendaInput[];
  decisions?: MeetingDecisionInput[];
  learnings?: MeetingLearningInput[];
  participantRoles: AgentIdentity["role"][];
  memoryModifications?: MemoryModificationInput[];
  taskModifications?: TaskModificationInput[];
}): Promise<MemoryModificationInput[]> {
  const unblockMods = (params.taskModifications ?? []).filter((m) => m.modificationType === "unblock");
  const unblockTaskRows = await Promise.all(
    unblockMods.map(async (modification) => {
      const task = await tasksRepo.findByIdHydrated(getDb(), modification.taskId);
      return task ? { modification, role: task.assignedRole } : null;
    }),
  );
  const clearBlockerModifications = unblockTaskRows
    .filter((entry): entry is { modification: TaskModificationInput; role: AgentIdentity["role"] } => entry !== null)
    .map(({ modification, role }) => ({
      role,
      modificationType: "clear_blocker" as const,
      content: modification.details,
    }));

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

/**
 * Apply all task and memory modifications produced by a meeting.
 *
 * Spec 31 Phase 7.B.2 — the function pre-resolves the agents needed
 * by `applyTaskModification` (one canonical read per distinct
 * `assignedRole`) so the per-mod loop stays synchronous. Memory mods
 * still fire-and-forget so callers don't have to await per-message
 * persistence.
 */
export async function applyMeetingEffects(
  companyId: string,
  taskModifications: TaskModificationInput[],
  memoryModifications: MemoryModificationInput[],
): Promise<void> {
  const distinctAssignedRoles = Array.from(
    new Set(
      taskModifications
        .map((m) => m.assignedRole)
        .filter((role): role is AgentIdentity["role"] => Boolean(role)),
    ),
  );
  const agentByRole = new Map<AgentIdentity["role"], { id: string }>();
  for (const role of distinctAssignedRoles) {
    const agent = await agentsRepo.findAgentByRole(getDb(), companyId, role);
    if (agent) agentByRole.set(role, { id: agent.id });
  }

  for (const modification of taskModifications) {
    applyTaskModification(companyId, modification, agentByRole);
  }

  if (memoryModifications.length === 0) return;
  for (const modification of memoryModifications) {
    // Audit C2: each modification is independently fire-and-forget;
    // routing through swallowAndAudit means a single embed/DB failure
    // surfaces with context (which modification) instead of being
    // collapsed under one console.warn.
    swallowAndAudit("meeting.memory_modification", () =>
      applyMemoryModification(companyId, modification),
      { companyId, detail: { modificationType: modification.modificationType, role: modification.role } },
    );
  }
}
