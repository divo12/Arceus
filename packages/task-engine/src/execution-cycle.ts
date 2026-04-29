import type { Task, Sprint, CompanySnapshot, ExecutionStatus } from "@arceus/contracts";

// ---------------------------------------------------------------------------
// Dependency-injection interfaces
// ---------------------------------------------------------------------------

export interface ExecutionCycleCallbacks {
  /** Spec 31 Phase 7.C.b — async because the snapshot is now assembled
   *  from canonical reads on demand, not held in memory. */
  getSnapshot: () => Promise<CompanySnapshot>;
  updateTask: (id: string, updater: (t: Task) => Task) => void;
  emitEmployeeActivity: (role: string, type: string, message: string, detail: { taskId?: string | null }) => void;
  recordMeeting: (params: {
    type: string;
    facilitatorRole: string;
    participantRoles: string[];
    summary: string;
    agenda: { topic: string; type: string; content: string; raisedByRole: string; relatedTaskId: string | null }[];
    decisions: { description: string; decidedByRoles: string[]; impactIds: string[] }[];
    learnings?: { role: string; content: string }[];
  }) => void;
  checkSprintCompletion: () => Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Pure decision functions
// ---------------------------------------------------------------------------

/**
 * Count queued (created | planned) non-core tasks.
 * `coreTaskKinds` is the set of task kinds that count as "core execution".
 */
export function getQueuedNonCoreTaskCount(
  snapshot: CompanySnapshot,
  coreTaskKinds: Set<Task["kind"]>,
): number {
  return snapshot.tasks.filter(
    (task) => !coreTaskKinds.has(task.kind) && ["created", "planned"].includes(task.status),
  ).length;
}

/**
 * Pure: decide whether execution should pause for board review.
 *
 * Pauses when pending approvals exist or when core tasks are not terminal.
 * Failed/blocked specialist tasks do NOT gate execution.
 */
export function shouldPauseForBoardReview(
  snapshot: CompanySnapshot,
  coreTaskKinds: Set<Task["kind"]>,
): { shouldPause: boolean; reason: string | null } {
  const pendingApprovals = snapshot.approvals.filter((approval) => approval.status === "pending");
  if (pendingApprovals.length > 0) {
    return {
      shouldPause: true,
      reason: `Board action required because ${pendingApprovals.length} approval request${pendingApprovals.length === 1 ? " is" : "s are"} still pending.`,
    };
  }

  const incompleteCoreTasks = snapshot.tasks.filter(
    (task) => coreTaskKinds.has(task.kind) && !["completed", "cancelled"].includes(task.status),
  );
  if (incompleteCoreTasks.length > 0) {
    return {
      shouldPause: true,
      reason: "Board review required because core execution is not in a terminal state.",
    };
  }

  return { shouldPause: false, reason: null };
}

/**
 * Complete the execution cycle: mark execution done, record a meeting,
 * and check for sprint completion.
 *
 * Manages `executionStatus` and `activeExecution` state via the returned values.
 */
export async function completeExecutionCycle(
  cb: ExecutionCycleCallbacks,
  coreTaskKinds: Set<Task["kind"]>,
  activeExecution: { reviewTaskId: string } | null,
  reason: string,
): Promise<void> {
  const snapshot = await cb.getSnapshot();
  const queuedNonCoreTaskCount = getQueuedNonCoreTaskCount(snapshot, coreTaskKinds);

  cb.emitEmployeeActivity(
    "system",
    "info",
    queuedNonCoreTaskCount > 0
      ? `${reason} ${queuedNonCoreTaskCount} queued non-core task${queuedNonCoreTaskCount === 1 ? " remains" : "s remain"} for a later cycle.`
      : reason,
    { taskId: activeExecution?.reviewTaskId ?? null },
  );

  if (activeExecution) {
    cb.updateTask(activeExecution.reviewTaskId, (task) => ({
      ...task,
      verifierState: {
        ...task.verifierState,
        isVerified: true,
        feedback: queuedNonCoreTaskCount > 0
          ? `Autonomous execution completed. ${queuedNonCoreTaskCount} queued non-core task${queuedNonCoreTaskCount === 1 ? " remains" : "s remain"} for a later cycle.`
          : "Autonomous execution completed without requiring additional board review.",
      },
    }));
  }

  cb.recordMeeting({
    type: "eval_triggered",
    facilitatorRole: "ceo",
    participantRoles: ["ceo", "cto"],
    summary: queuedNonCoreTaskCount > 0
      ? "Autonomous execution completed and left queued non-core tasks for a future cycle."
      : "Autonomous execution completed without requiring additional board review.",
    agenda: [
      {
        topic: "Autonomous cycle completion",
        type: "update",
        content: reason,
        raisedByRole: "ceo",
        relatedTaskId: activeExecution?.reviewTaskId ?? null,
      },
    ],
    decisions: [
      {
        description: queuedNonCoreTaskCount > 0
          ? `Cycle closed with ${queuedNonCoreTaskCount} queued non-core task${queuedNonCoreTaskCount === 1 ? "" : "s"} for later execution.`
          : "Cycle closed without further board intervention.",
        decidedByRoles: ["ceo", "cto"],
        impactIds: activeExecution ? [activeExecution.reviewTaskId] : [],
      },
    ],
  });

  // After execution cycle completes, check if the sprint is done
  await cb.checkSprintCompletion();
}
