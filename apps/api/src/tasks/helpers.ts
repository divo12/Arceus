import type { Task, CompanySnapshot } from "@arceus/contracts";
import { updateTask } from "../persistence/mutations.js";
import { audit } from "../observability/audit-ledger.js";
import { swallowAndAudit } from "../observability/swallow.js";
import { isTaskReady } from "@arceus/task-engine";
import { CORE_EXECUTION_TASK_KINDS, AUTONOMOUS_READY_TASK_ROLES } from "../orchestration/state.js";

/**
 * Mark a task as independently verified. Spec 31 Phase 7.B.2 — caller
 * threads `companyId` so the audit log can attribute the event without
 * touching the in-memory snapshot. MUST be called by a verification
 * step (preview validation, tester, CTO review) — not by the agent
 * that did the work.
 */
export function setTaskVerified(companyId: string, taskId: string, verifiedBy: string) {
  swallowAndAudit("task.set_verified", () => updateTask(taskId, (task) => ({
    ...task,
    verifierState: {
      ...task.verifierState,
      isVerified: true,
      feedback: task.verifierState.feedback
        ? `${task.verifierState.feedback} | Verified by ${verifiedBy}`
        : `Verified by ${verifiedBy}`,
    },
  })), { companyId, detail: { taskId, verifiedBy } });
  audit({
    companyId,
    category: "task_lifecycle",
    severity: "info",
    eventType: "task_verified",
    agentRole: null,
    summary: `Task "${taskId}" independently verified by ${verifiedBy}`,
    detail: { taskId, verifiedBy },
    correlationId: taskId,
  });
}

/** Extract the top-level directory from the most recent edited file result on a task. */
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

/** Return true if a specialist task can run autonomously (correct role, not a core kind, deps met). */
export function isTaskReadyForAutonomousExecution(task: Task, snapshot: CompanySnapshot) {
  if (!AUTONOMOUS_READY_TASK_ROLES.has(task.assignedRole)) return false;
  if (CORE_EXECUTION_TASK_KINDS.has(task.kind)) return false;
  return isTaskReady(task, snapshot);
}
