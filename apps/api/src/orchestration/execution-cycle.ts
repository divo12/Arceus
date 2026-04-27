/**
 * Execution cycle lifecycle — completion, pause, board review, and stop.
 */

import type { AgentIdentity } from "@arceus/contracts";
import { uniqueStrings, nowIso } from "@arceus/task-engine";
import { getSnapshot, updateTask } from "../persistence/store.js";
import { emitEmployeeActivity } from "../observability/activity.js";
import { emitGraphDecision } from "../observability/graph-emitter.js";
import { stopLocalPreview } from "../workspace/preview.js";
import { auditSystem } from "../observability/audit-ledger.js";
import {
  activeExecution,
  executionStatus,
  setExecutionStatus,
  setActiveExecution,
  agentSessions,
  getQueuedNonCoreTaskCount,
  shouldPauseForBoardReview,
} from "./state.js";
import { recordMeeting } from "../meetings/recording.js";
import { approvePendingBoardApprovals } from "../memory/handoffs.js";
import { clearDeveloperWatchdog } from "../workspace/watchdog.js";
import { stopDeveloperWorkspaceMonitor } from "../workspace/monitor.js";
import { setTaskStatus } from "../tasks/mutations.js";
import { checkSprintCompletion } from "../sprints/lifecycle.js";

/** Finalize the current execution cycle: update status, record meeting, and check sprint completion. */
export async function completeExecutionCycle(reason: string) {
  const snapshot = getSnapshot();
  const queuedNonCoreTaskCount = getQueuedNonCoreTaskCount(snapshot);
  setExecutionStatus("done");

  emitEmployeeActivity(
    "system",
    "info",
    queuedNonCoreTaskCount > 0
      ? `${reason} ${queuedNonCoreTaskCount} queued non-core task${queuedNonCoreTaskCount === 1 ? " remains" : "s remain"} for a later cycle.`
      : reason,
    {
      taskId: activeExecution?.reviewTaskId ?? null,
    },
  );

  if (activeExecution) {
    updateTask(activeExecution.reviewTaskId, (task) => ({
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

  await recordMeeting({
    type: "eval_triggered",
    facilitatorRole: "ceo",
    participantRoles: ["ceo", "cto"],
    summary: queuedNonCoreTaskCount > 0
      ? "Autonomous execution completed and left queued non-core tasks for a future cycle."
      : "Autonomous execution completed without requiring additional board review.",
    agenda: [{
      topic: "Autonomous cycle completion",
      type: "update",
      content: reason,
      raisedByRole: "ceo",
      relatedTaskId: activeExecution?.reviewTaskId ?? null,
    }],
    decisions: [{
      description: queuedNonCoreTaskCount > 0
        ? `Cycle closed with ${queuedNonCoreTaskCount} queued non-core task${queuedNonCoreTaskCount === 1 ? "" : "s"} for later execution.`
        : "Cycle closed without further board intervention.",
      decidedByRoles: ["ceo", "cto"],
      impactIds: activeExecution ? [activeExecution.reviewTaskId] : [],
    }],
  });

  setActiveExecution(null);

  await checkSprintCompletion();
}

/** Pause execution and request board-level intervention. */
export async function pauseForBoardReview(reason: string) {
  setExecutionStatus("awaiting_board_review");
  await recordMeeting({
    type: "eval_triggered",
    facilitatorRole: "cto",
    participantRoles: ["cto", "ceo"],
    summary: "Autonomous execution paused for a board-level decision.",
    agenda: [{
      topic: "Board review checkpoint",
      type: "proposal",
      content: reason,
      raisedByRole: "ceo",
      relatedTaskId: activeExecution?.reviewTaskId ?? null,
    }],
    decisions: [{
      description: "Execution is paused pending explicit board intervention.",
      decidedByRoles: ["cto", "ceo"],
      impactIds: activeExecution ? [activeExecution.reviewTaskId] : [],
    }],
    learnings: [{
      role: "ceo",
      content: "Board review is now an exception path triggered by policy or unresolved execution risk.",
    }],
  });
  emitEmployeeActivity("system", "info", reason, {
    taskId: activeExecution?.reviewTaskId ?? null,
  });
}

/** Run post-review reconciliation: then complete or pause. */
export async function reconcilePostReviewExecution() {
  const snapshot = getSnapshot();
  const boardDecision = shouldPauseForBoardReview(snapshot);

  {
    const pauseSprintId = snapshot.company.currentSprintId;
    if (pauseSprintId) {
      emitGraphDecision(pauseSprintId, null, boardDecision.shouldPause ? "escalation" : "auto_approve",
        boardDecision.shouldPause ? "Board review required" : "Auto-approved — continuing execution",
        boardDecision.reason ?? "No blocking items",
        "system");
    }
  }

  if (boardDecision.shouldPause) {
    await pauseForBoardReview(boardDecision.reason ?? "Board review required.");
    return;
  }

  await completeExecutionCycle("Autonomous execution completed — all phases finished.");
}

/** Forcibly stop the current execution cycle, blocking in-progress tasks and idling agents. */
export async function stopExecution(reason = "Board manually stopped company execution.") {
  if (["idle", "done", "error", "paused"].includes(executionStatus) && !activeExecution) {
    throw new Error("No active company execution is running.");
  }
  auditSystem(getSnapshot().company.id, "execution_stopped", `Execution stopped: ${reason}`, { severity: "warn" });

  clearDeveloperWatchdog();
  stopDeveloperWorkspaceMonitor();
  await stopLocalPreview();

  const snapshot = getSnapshot();
  const impactedTaskIds = snapshot.tasks
    .filter((task) => ["in_progress", "verifying"].includes(task.status))
    .map((task) => task.id);

  for (const taskId of impactedTaskIds) {
    setTaskStatus(taskId, "blocked", reason);
  }

  for (const session of agentSessions.values()) {
    if (session.status === "working") {
      session.status = "idle";
      session.lastEventAt = nowIso();
    }
  }

  setExecutionStatus("paused");

  await recordMeeting({
    type: "escalation",
    facilitatorRole: "ceo",
    participantRoles: uniqueStrings([
      "ceo",
      "cto",
      ...snapshot.tasks
        .filter((task) => impactedTaskIds.includes(task.id))
        .map((task) => task.assignedRole),
    ]) as AgentIdentity["role"][],
    summary: "Board manually stopped the current execution cycle.",
    agenda: [{
      topic: "Manual stop",
      type: "blocker",
      content: reason,
      raisedByRole: "ceo",
      relatedTaskId: activeExecution?.reviewTaskId ?? impactedTaskIds[0] ?? null,
    }],
    decisions: [{
      description: "The current execution cycle is paused until the board starts a new run.",
      decidedByRoles: ["ceo", "cto"],
      impactIds: uniqueStrings([activeExecution?.reviewTaskId ?? null, ...impactedTaskIds]),
    }],
  });

  emitEmployeeActivity("system", "info", reason, {
    taskId: activeExecution?.reviewTaskId ?? impactedTaskIds[0] ?? null,
  });

  setActiveExecution(null);

  return { executionStatus, reason };
}

/** Approve a pending board review: resolve approvals, mark execution done, and check sprint completion. */
export async function approveBoardReview() {
  if (executionStatus !== "awaiting_board_review" || !activeExecution) {
    throw new Error("Board review is not awaiting approval.");
  }

  const reviewTaskId = activeExecution.reviewTaskId;
  const companyId = getSnapshot().company.id;
  const queuedFollowUpCount = getSnapshot().tasks.filter(
    (task) => task.kind === "follow_up" && ["created", "planned"].includes(task.status)
  ).length;
  const resolvedApprovals = await approvePendingBoardApprovals(companyId);

  setExecutionStatus("done");
  emitEmployeeActivity(
    "system",
    "info",
    queuedFollowUpCount > 0 || resolvedApprovals.length > 0
      ? `Board approved the CTO handoff. Execution is complete. ${queuedFollowUpCount > 0 ? `${queuedFollowUpCount} follow-up task${queuedFollowUpCount === 1 ? "" : "s"} remain queued for the next cycle. ` : ""}${resolvedApprovals.length > 0 ? `${resolvedApprovals.length} pending approval request${resolvedApprovals.length === 1 ? " was" : "s were"} resolved.` : ""}`.trim()
      : "Board approved the CTO handoff. Execution is marked complete.",
    { taskId: reviewTaskId },
  );

  updateTask(reviewTaskId, (task) => ({
    ...task,
    verifierState: {
      ...task.verifierState,
      isVerified: true,
      feedback: queuedFollowUpCount > 0 || resolvedApprovals.length > 0
        ? `Board approved the handoff.${queuedFollowUpCount > 0 ? ` ${queuedFollowUpCount} follow-up task${queuedFollowUpCount === 1 ? "" : "s"} remain queued for the next cycle.` : ""}${resolvedApprovals.length > 0 ? ` ${resolvedApprovals.length} pending approval request${resolvedApprovals.length === 1 ? " was" : "s were"} resolved.` : ""}`
        : "Board approved the handoff and closed the current cycle.",
    },
  }));

  await recordMeeting({
    type: "eval_triggered",
    facilitatorRole: "ceo",
    participantRoles: ["ceo", "cto"],
    summary: "Board approved the CTO handoff and closed the current execution cycle.",
    agenda: [{
      topic: "Board approval",
      type: "proposal",
      content: "The board accepted the CTO handoff artifact and closed the current increment.",
      raisedByRole: "ceo",
      relatedTaskId: reviewTaskId,
    }],
    decisions: [{
      description: queuedFollowUpCount > 0 || resolvedApprovals.length > 0
        ? `Execution is complete.${queuedFollowUpCount > 0 ? ` ${queuedFollowUpCount} follow-up task${queuedFollowUpCount === 1 ? "" : "s"} are queued for the next cycle.` : ""}${resolvedApprovals.length > 0 ? ` ${resolvedApprovals.length} approval request${resolvedApprovals.length === 1 ? " was" : "s were"} resolved by the board.` : ""}`
        : "Execution is complete until the board starts another cycle.",
      decidedByRoles: ["ceo", "cto"],
      impactIds: [reviewTaskId],
    }],
    learnings: [{
      role: "ceo",
      content: "Board review closed the loop after CTO handoff without resuming autonomous execution.",
    }],
  });

  setActiveExecution(null);
  await checkSprintCompletion();

  return {
    executionStatus,
    reviewTaskId,
    queuedFollowUpCount,
    resolvedApprovalCount: resolvedApprovals.length,
  };
}
