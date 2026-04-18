import type { Task, CompanySnapshot, AgentIdentity } from "@arceus/contracts";
import { getSnapshot, updateTask } from "../persistence/store.js";
import { audit } from "../observability/audit-ledger.js";
import { isTaskReady } from "@arceus/task-engine";
import { CORE_EXECUTION_TASK_KINDS, AUTONOMOUS_READY_TASK_ROLES } from "../orchestration/state.js";

/**
 * Mark a task as independently verified. This MUST be called by a verification
 * step (preview validation, tester, CTO review) — not by the agent that did
 * the work.
 */
export function setTaskVerified(taskId: string, verifiedBy: string) {
  updateTask(taskId, (task) => ({
    ...task,
    verifierState: {
      ...task.verifierState,
      isVerified: true,
      feedback: task.verifierState.feedback
        ? `${task.verifierState.feedback} | Verified by ${verifiedBy}`
        : `Verified by ${verifiedBy}`,
    },
  }));
  audit({
    companyId: getSnapshot().company.id,
    category: "task_lifecycle",
    severity: "info",
    eventType: "task_verified",
    agentRole: null,
    summary: `Task "${taskId}" independently verified by ${verifiedBy}`,
    detail: { taskId, verifiedBy },
    correlationId: taskId,
  });
}

export function getPreferredPreviewTargetPathFromTask(task: Task | null | undefined) {
  if (!task) return null;

  const editedResult = [...task.executorState.results]
    .reverse()
    .find((entry) => entry.startsWith("edited:"));

  if (!editedResult) return null;

  const relativePath = editedResult.slice("edited:".length).replace(/\\/g, "/");
  if (!relativePath || relativePath.startsWith(".")) return null;

  return relativePath.split("/")[0] ?? null;
}

export function isTaskReadyForAutonomousExecution(task: Task, snapshot: CompanySnapshot) {
  if (!AUTONOMOUS_READY_TASK_ROLES.has(task.assignedRole)) return false;
  if (CORE_EXECUTION_TASK_KINDS.has(task.kind)) return false;
  return isTaskReady(task, snapshot);
}
