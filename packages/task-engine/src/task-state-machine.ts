import type { Task, CompanySnapshot, AgentIdentity } from "@arceus/contracts";
import { getAgentByRole, uniqueStrings } from "./task-helpers";
import { MAX_INCOMING_ARTIFACT_IDS } from "./limits";

// ---------------------------------------------------------------------------
// Dependency-injection interface
// ---------------------------------------------------------------------------

export interface AuditEntry {
  companyId: string;
  category: string;
  severity: "info" | "warn" | "error";
  eventType: string;
  agentRole: string | null;
  summary: string;
  detail: Record<string, unknown>;
  correlationId: string;
}

export interface TaskStatusCallbacks {
  /** Read current state. Spec 31 Phase 7.C.b — async to read from canonical. */
  getSnapshot: () => Promise<CompanySnapshot>;
  /** Mutate a task in the store. */
  updateTask: (id: string, updater: (t: Task) => Task) => void;
  /** Resolve the active sprint ID (may differ from company.currentSprintId during transitions). */
  resolveActiveSprintId: () => string | null;
  /** Write an audit-ledger entry. */
  audit: (entry: AuditEntry) => void;
  /** Trigger an escalation meeting when a task becomes blocked. */
  triggerEscalationMeeting: (taskId: string, reason: string) => void;
  /** Wake a specific role via reactive event. */
  emitReactive: (role: string, event: string) => void;
  /** Spec 22 graph instrumentation — status change. */
  emitGraphStatusChanged?: (
    sprintId: string,
    taskId: string,
    from: string,
    to: string,
    role: string,
    note: string,
  ) => void;
  /** Spec 22 graph instrumentation — artifact consumption edge. */
  emitGraphArtifactConsumed?: (
    sprintId: string,
    consumerId: string,
    producerId: string,
    artifactIds: string[],
    note: string | null,
  ) => void;
  /**
   * Hook called after a terminal status (completed / failed / cancelled) is applied.
   * The orchestrator wires hippocampus, skill evolution, and pattern learning here.
   * This keeps the task-engine free of those domain-specific concerns.
   */
  onTerminalStatus?: (
    taskId: string,
    task: Task,
    agent: AgentIdentity | null,
    status: Task["status"],
    feedback: string | null,
  ) => void;
}

// ---------------------------------------------------------------------------
// Core task status transition with cascading logic
// ---------------------------------------------------------------------------

/**
 * Transition a task to a new status, with:
 * - Audit logging
 * - Graph instrumentation
 * - Escalation on "blocked"
 * - Artifact propagation to children on "completed"
 * - Dependency promotion (created → planned) on "completed"
 * - Terminal-status hook for downstream integrations
 */
export async function setTaskStatus(
  cb: TaskStatusCallbacks,
  taskId: string,
  status: Task["status"],
  feedback?: string | null,
): Promise<void> {
  // Spec 31 Phase 7.C.b — async because cb.getSnapshot is async.
  // Single read at the top; reused throughout instead of refetching.
  const initialSnapshot = await cb.getSnapshot();
  const prev = initialSnapshot.tasks.find((t) => t.id === taskId);
  const prevStatus = prev?.status ?? "unknown";

  // 1. Apply the status update
  cb.updateTask(taskId, (task) => ({
    ...task,
    status,
    verifierState: {
      ...task.verifierState,
      // isVerified is NOT auto-stamped on completion — it must be set
      // explicitly by an independent verification step (preview validation,
      // tester, or CTO review).
      feedback: feedback ?? task.verifierState.feedback,
    },
  }));

  // 2. Graph instrumentation (Spec 22)
  const sprintId = prev?.sprintId ?? cb.resolveActiveSprintId();
  if (sprintId) {
    cb.emitGraphStatusChanged?.(
      sprintId, taskId, prevStatus, status,
      prev?.assignedRole ?? "system",
      feedback ?? `${prevStatus} → ${status}`,
    );
  }

  // 3. Audit the transition
  cb.audit({
    companyId: prev?.companyId ?? initialSnapshot.company.id,
    category: "task_lifecycle",
    severity: status === "failed" ? "warn" : "info",
    eventType: `task_${status}`,
    agentRole: prev?.assignedRole ?? null,
    summary: `Task "${prev?.title ?? taskId}" ${prevStatus} → ${status}`,
    detail: { taskId, previousStatus: prevStatus, feedback: feedback ?? null },
    correlationId: taskId,
  });

  // 4. Trigger escalation when a task becomes blocked
  if (status === "blocked" && prevStatus !== "blocked") {
    cb.triggerEscalationMeeting(
      taskId,
      feedback ?? `Task "${prev?.title ?? taskId}" is blocked`,
    );
  }

  // 5. Cascading on completion — artifact propagation + dependency promotion.
  // Re-read here because step 1's updateTask landed since `initialSnapshot`,
  // and we want the post-update view of the completed task.
  if (status === "completed") {
    const snapshot = await cb.getSnapshot();
    const completedTask = snapshot.tasks.find((t) => t.id === taskId);

    // Propagate artifacts from the completed task to its direct children
    if (completedTask && completedTask.artifactIds.length > 0) {
      for (const childId of completedTask.childTaskIds) {
        cb.updateTask(childId, (t) => ({
          ...t,
          incomingArtifactIds: uniqueStrings(
            [...t.incomingArtifactIds, ...completedTask.artifactIds],
            MAX_INCOMING_ARTIFACT_IDS,
          ),
        }));
        const sid = completedTask.sprintId ?? cb.resolveActiveSprintId();
        if (sid) {
          cb.emitGraphArtifactConsumed?.(sid, childId, taskId, completedTask.artifactIds, null);
        }
      }
    }

    // Promote downstream tasks whose dependencies are now met
    for (const task of snapshot.tasks) {
      if (task.status !== "created") continue;
      if (task.kind === "follow_up") continue;
      if (task.dependsOnTaskIds.length === 0) continue;

      const allDepsMet = task.dependsOnTaskIds.every((depId) => {
        const dep = snapshot.tasks.find((t) => t.id === depId);
        return dep?.status === "completed";
      });

      if (allDepsMet) {
        // Propagate artifacts from all completed dependencies
        const upstreamArtifactIds: string[] = [];
        for (const depId of task.dependsOnTaskIds) {
          const dep = snapshot.tasks.find((t) => t.id === depId);
          if (dep) {
            upstreamArtifactIds.push(...dep.artifactIds);
            if (dep.artifactIds.length > 0) {
              const sid = dep.sprintId ?? cb.resolveActiveSprintId();
              if (sid) {
                cb.emitGraphArtifactConsumed?.(sid, task.id, depId, dep.artifactIds, null);
              }
            }
          }
        }
        cb.updateTask(task.id, (t) => ({
          ...t,
          status: "planned",
          incomingArtifactIds: uniqueStrings(
            [...t.incomingArtifactIds, ...upstreamArtifactIds],
            MAX_INCOMING_ARTIFACT_IDS,
          ),
        }));
        // Reactive: wake the assignee — their dependency is now met
        if (task.assignedRole) {
          cb.emitReactive(task.assignedRole, "task_dependency_met");
        }
      }
    }
  }

  // 6. Terminal-status hook (hippocampus, skill evolution, patterns)
  if (["completed", "failed", "cancelled"].includes(status)) {
    const snapshot = await cb.getSnapshot();
    const task = snapshot.tasks.find((t) => t.id === taskId);
    if (task) {
      const agent = getAgentByRole(snapshot, task.assignedRole);
      cb.onTerminalStatus?.(taskId, task, agent, status, feedback ?? null);
    }
  }
}
