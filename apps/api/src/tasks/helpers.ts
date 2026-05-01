import type { Task, CompanySnapshot } from "@arceus/contracts";
import { updateTask } from "../persistence/mutations/index.js";
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

