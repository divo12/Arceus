import type { AgentIdentity, Sprint, SprintReviewState, Task } from "@arceus/contracts";
import { getAgentByRole, createWorkflowTask, nowIso } from "@arceus/task-engine";
import { appendChatMessage, updateSprint, updateTask, upsertTask } from "../persistence/mutations/index.js";
import { requireActiveCompanyId } from "../persistence/active-company.js";
import { buildSnapshotView } from "../orchestration/snapshot-view.js";
import { emitEmployeeActivity } from "../observability/activity.js";
import {
  emitGraphDecision,
  emitGraphSprintCompleted,
  emitGraphNodeAdded,
} from "../observability/graph-emitter/index.js";
import { getLocalPreviewState, startLocalPreview } from "../workspace/preview.js";
import { workspaceManager } from "../workspace/manager.js";
import { createReviewState, buildGateFailureBugFields } from "./review-helpers.js";
import { runVerificationGate } from "./verification-gate.js";
import { emitReactive } from "../orchestration/reactive.js";
import { runCrossSprintTransfer } from "../skills/cross-sprint.js";
import { swallowAndAudit } from "../observability/swallow.js";
import {
  sprintCompletionGate,
  getExecutionStatus,
  setExecutionStatus,
  setActiveExecution,
  getActiveExecution,
} from "../orchestration/state.js";
import { getDb } from "@arceus/db";
import * as tasksRepo from "@arceus/db/src/repos/tasks/index.js";
import { recordMeeting } from "../meetings/recording.js";
import { approvePendingBoardApprovals } from "../memory/handoffs.js";

/**
 * Checks if all employee tasks in the current sprint have reached terminal status.
 * If so, enters the "reviewing" phase (Spec 21) instead of immediately completing.
 *
 * Audit C6 (F-043/F-315): the previous `sprintCompletionTriggered`
 * boolean had a check-then-set race — a second task-completion event
 * could observe `false` between the check at the top and the
 * `setSprintCompletionTriggered(true)` assignment 30 lines down (every
 * intervening `await` is an interleave point). Now `sprintCompletionGate`
 * (`TryRunGate.runExclusive`) does the check-and-claim atomically; a
 * concurrent caller gets `null` and the outer function maps that to
 * `false` (same observable behaviour as the old early-return).
 */
export async function checkSprintCompletion(companyIdArg?: string): Promise<boolean> {
  const result = await sprintCompletionGate.runExclusive(async () => {
    // Spec 31 Phase 7.B.4 — read snapshot via canonical-backed view.
    // Scope to the company whose task just went terminal, NOT the global
    // active-company pointer. The pointer is a single in-memory value;
    // under multi-tenancy (or a stale pointer left by a deleted company)
    // it can name the WRONG company, and buildSnapshotView then throws
    // "company not found" → the error is swallowed → the sprint never
    // finalizes and the next sprint never proposes. Observed live
    // 2026-06-12: CaseBrief finished all tasks but the pointer named a
    // deleted company, so sprint 1 hung in `active`. Callers that have
    // the company (the task-terminal trigger) pass it explicitly.
    const companyId = companyIdArg ?? requireActiveCompanyId();
    const snapshot = await buildSnapshotView(companyId);
  const currentSprintId = snapshot.company.currentSprintId;
  if (!currentSprintId) return false;

  const currentSprint = snapshot.sprints.find((s) => s.id === currentSprintId);
  if (!currentSprint || currentSprint.status === "completed" || currentSprint.status === "reviewing") return false;

  const sprintTasks = snapshot.tasks.filter(
    (t) => t.sprintId === currentSprintId && t.kind !== "follow_up" && t.kind !== "bug_fix",
  );
  if (sprintTasks.length === 0) return false;

  const allTerminal = sprintTasks.every((t) =>
    ["completed", "cancelled", "failed"].includes(t.status),
  );
  if (!allTerminal) {
    const statusCounts = { completed: 0, planned: 0, in_progress: 0, failed: 0, cancelled: 0, created: 0 } as Record<string, number>;
    sprintTasks.forEach(t => { statusCounts[t.status] = (statusCounts[t.status] || 0) + 1; });
    emitEmployeeActivity("system", "context", `Sprint ${currentSprint.number} completion check: NOT all terminal — ${JSON.stringify(statusCounts)}`, {
      detail: { sprintNumber: currentSprint.number, totalTasks: sprintTasks.length, statusCounts },
    });
    return false;
  }

  emitEmployeeActivity("system", "transition", `Sprint ${currentSprint.number} → REVIEWING (all implementation tasks terminal)`, {
    detail: { sprintNumber: currentSprint.number, sprintId: currentSprintId },
  });

  emitGraphDecision(currentSprintId, null, "task_completion",
    `Sprint ${currentSprint.number} → REVIEWING`,
    `All ${sprintTasks.length} implementation tasks reached terminal status`,
    "system", 1.0);

  const reviewState = createReviewState(3);

  await updateSprint(currentSprintId, (sprint) => ({
    ...sprint,
    status: "reviewing",
    reviewState,
  }));

  const companyIdForGate = snapshot.company.id;
  const productDirForGate = workspaceManager.getLocalPath(companyIdForGate);

  // Ensure a preview is running before the gate probes it. The workspace
  // monitor that used to auto-start previews after each developer beat is
  // not wired in this code path, so the gate would otherwise always see
  // "Preview not started" and the tester would force-fail every sprint.
  const previewBeforeGate = getLocalPreviewState(companyIdForGate);
  if (previewBeforeGate.status !== "ready" && previewBeforeGate.status !== "starting") {
    try {
      const started = await startLocalPreview(productDirForGate, null, companyIdForGate);
      if (started.status === "ready") {
        const url = started.url ?? started.entryUrl ?? started.validationUrl;
        emitEmployeeActivity("system", "preview", `Preview auto-started before review gate → ${url ?? "(no url)"}`, {
          detail: { sprintId: currentSprintId, status: started.status, url },
        });
      } else {
        emitEmployeeActivity("system", "preview", `Preview auto-start before review gate did not become reachable: ${started.lastError ?? started.status}`, {
          detail: { sprintId: currentSprintId, status: started.status, lastError: started.lastError },
        });
      }
    } catch (err) {
      emitEmployeeActivity("system", "error", `Preview auto-start before review gate threw: ${err instanceof Error ? err.message : String(err)}`, {
        detail: { sprintId: currentSprintId },
      });
    }
  }

  const gateResult = await runVerificationGate(productDirForGate, "pre_review", undefined, companyIdForGate);

  emitGraphDecision(currentSprintId, null, "gate_verdict",
    `Pre-review gate: ${gateResult.passed ? "PASSED" : "FAILED"}`,
    gateResult.passed ? "Build check passed" : `Build check failed: ${gateResult.buildResult?.stderr?.slice(0, 200) ?? "unknown error"}`,
    "system", gateResult.passed ? 1.0 : 0);

  reviewState.gateResults.push(gateResult);

  if (!gateResult.passed) {
    emitEmployeeActivity("system", "transition", `Sprint ${currentSprint.number} pre-review gate FAILED — creating build fix task`, {
      detail: { gateResult },
    });

    const bugFields = buildGateFailureBugFields(gateResult, currentSprintId);
    if (bugFields) {
      const bugTask = createWorkflowTask(
        snapshot, bugFields.kind, bugFields.assignedRole,
        bugFields.title, bugFields.description, bugFields.problemStatement,
        bugFields.deliverable, bugFields.definitionOfDone, bugFields.priority, "planned",
        bugFields.sprintId,
      );
      await upsertTask(bugTask);
      reviewState.bugTaskIds.push(bugTask.id);
      reviewState.phase = "rework";

      emitGraphNodeAdded(currentSprintId, bugTask);
      emitReactive(snapshot.company.id, bugFields.assignedRole, "bug_reported");
    }
  } else {
    // Pre-review build gate passed. The sprint plan already includes
    // tester + CTO review tasks (those completed alongside other tasks
    // before this gate ran), so re-running an LLM-driven verification
    // here is redundant. Trust the build gate as the automated safety
    // net and finalize the sprint directly.
    //
    // Trade-off (see commit message): we lose the inline preview probe,
    // entry-point import check, and rework-loop. Build failures still
    // route through the FAIL branch above and create a bug task. Taken
    // because in practice agents include verification work as real
    // sprint tasks, and the redundant LLM round-trip was eating 2-3
    // minutes per sprint with no signal the build gate didn't already
    // cover.
    emitEmployeeActivity("system", "transition", `Sprint ${currentSprint.number} pre-review gate PASSED — finalizing sprint directly (Option A: skip tester_verification + final_gate)`, {
      detail: { gateResult },
    });
    reviewState.phase = "complete";
  }

  await updateSprint(currentSprintId, (sprint) => ({
    ...sprint,
    reviewState,
  }));

    if (gateResult.passed) {
      // Run finalizeSprintCompletion outside the updateSprint above so
      // the reviewState write lands first. finalizeSprintCompletion is
      // idempotent (early-returns on sprint.status === "completed") and
      // does its own sprint update + chat-message emission.
      await finalizeSprintCompletion(currentSprintId, companyId);
    }

    return true;
  });
  // `runExclusive` returns `null` if a concurrent caller is already
  // running the body — same semantics as the old early-return `false`.
  return result ?? false;
}

/**
 * Complete the sprint after the reviewing phase is done (Spec 21).
 * Called when the final gate passes or CTO decides to skip.
 * Sets execution status to "done" so the heartbeat checklist picks up
 * the "no active sprint" condition and creates a governance task for the CEO.
 */
export async function finalizeSprintCompletion(
  sprintId: string,
  companyIdArg?: string,
): Promise<void> {
  // Spec 31 Phase 7.B.4 — read via canonical-backed view. Scope to the
  // passed company, NOT the global active-company pointer (see
  // checkSprintCompletion note — a stale/wrong pointer makes
  // buildSnapshotView throw and the sprint never closes).
  const companyId = companyIdArg ?? requireActiveCompanyId();
  const snapshot = await buildSnapshotView(companyId);
  const sprint = snapshot.sprints.find((s) => s.id === sprintId);
  if (!sprint) return;

  // Per vision: the agent (CEO) decided to finalize. Before completing,
  // ensure the user can see what was built by auto-starting preview if
  // one isn't already running. The preview stays alive until the next
  // sprint's workspace setup tears it down.
  const companyIdForPreview = snapshot.company.id;
  const productDirForPreview = workspaceManager.getLocalPath(companyIdForPreview);
  const currentPreview = getLocalPreviewState(companyIdForPreview);
  if (currentPreview.status !== "ready" && currentPreview.status !== "starting") {
    try {
      const started = await startLocalPreview(productDirForPreview, null, companyIdForPreview);
      const url = started.url ?? started.entryUrl ?? started.validationUrl;
      if (started.status === "ready" && url) {
        emitEmployeeActivity("system", "preview", `Preview auto-started for sprint ${sprint.number} finalization → ${url}`, {
          detail: { sprintId, status: started.status, url },
        });
        await appendChatMessage({
          id: `chat_${crypto.randomUUID()}`,
          companyId: snapshot.company.id,
          sprintId,
          agentId: null,
          role: "system",
          content: `🚀 Preview ready for Sprint ${sprint.number}: ${url}`,
          cardType: "status_update",
          cardData: { previewUrl: url, sprintNumber: sprint.number, phase: "sprint_finalized" },
          createdAt: nowIso(),
        });
      } else {
        emitEmployeeActivity("system", "preview", `Preview auto-start did not become reachable during finalization: ${started.lastError ?? started.status}`, {
          detail: { sprintId, status: started.status, lastError: started.lastError },
        });
      }
    } catch (err) {
      emitEmployeeActivity("system", "error", `Preview auto-start threw during finalization: ${err instanceof Error ? err.message : String(err)}`, {
        detail: { sprintId },
      });
    }
  } else {
    // Preview already running — surface the URL if we haven't already
    const existingUrl = currentPreview.url ?? currentPreview.entryUrl ?? currentPreview.validationUrl;
    if (existingUrl) {
      await appendChatMessage({
        id: `chat_${crypto.randomUUID()}`,
        companyId: snapshot.company.id,
        sprintId,
        agentId: null,
        role: "system",
        content: `🚀 Preview ready for Sprint ${sprint.number}: ${existingUrl}`,
        cardType: "status_update",
        cardData: { previewUrl: existingUrl, sprintNumber: sprint.number, phase: "sprint_finalized" },
        createdAt: nowIso(),
      });
    }
  }

  const sprintTasks = snapshot.tasks.filter(
    (t) => t.sprintId === sprintId && t.kind !== "follow_up",
  );
  const completedCount = sprintTasks.filter((t) => t.status === "completed").length;
  const failedCount = sprintTasks.filter((t) => t.status === "failed").length;
  const cancelledCount = sprintTasks.filter((t) => t.status === "cancelled").length;

  emitEmployeeActivity("system", "transition", `Sprint ${sprint.number} → COMPLETED (${completedCount}/${sprintTasks.length} delivered, ${failedCount} failed, ${cancelledCount} cancelled)`, {
    detail: { sprintNumber: sprint.number, sprintId, completedCount, failedCount, cancelledCount, totalTasks: sprintTasks.length },
  });

  // Audit C8 (F-347): tag the snapshot BEFORE flipping sprint status.
  // Previously we flipped to "completed" then awaited tagSprint, and if
  // the tag throw landed in the inner catch the sprint row stayed
  // `completed` while the canonical snapshot row was missing — operators
  // had no way to retry without a manual DB edit. Now tag-first means a
  // git/Supabase failure leaves the sprint in `reviewing` and an
  // operator (or the next finalize call) can retry cleanly.
  const tagResult = await tagCurrentSprintSnapshot();
  if (!tagResult.ok) {
    emitEmployeeActivity("system", "error", `Sprint ${sprint.number} completion HELD — snapshot tag failed: ${tagResult.error}`, {
      detail: { sprintId, sprintNumber: sprint.number, error: tagResult.error },
    });
    return;
  }

  await updateSprint(sprintId, (s) => ({
    ...s,
    status: "completed",
    completedAt: nowIso(),
    summary: `Sprint ${s.number} completed — ${completedCount}/${sprintTasks.length} tasks delivered.`,
    reviewState: s.reviewState ? { ...s.reviewState, phase: "complete" as const, completedAt: nowIso() } : s.reviewState,
  }));

  emitGraphSprintCompleted(sprintId, "completed");

  // Spec 14 Phase 6 / Audit C3.1 (F-377): cross-sprint pattern transfer is
  // fire-and-forget but failures must surface to the audit trail — without
  // this, an embedding/cluster failure means promotions silently never run
  // and the next sprint inherits zero patterns.
  swallowAndAudit("cross_sprint.transfer", async () => {
    const result = await runCrossSprintTransfer(snapshot.company.id, sprintId);
    if (result.candidatesFound > 0) {
      console.log(`[CrossSprintTransfer] Sprint ${sprint.number}: ${result.candidatesFound} candidates, ${result.mutationsProposed} proposed, ${result.mutationsRefused} refused`);
    }
  },
    { companyId: snapshot.company.id, detail: { sprintId, sprintNumber: sprint.number } },
  );

  const ceoAgent = getAgentByRole(snapshot, "ceo");
  await appendChatMessage({
    id: `chat_${crypto.randomUUID()}`,
    companyId: snapshot.company.id,
    sprintId,
    agentId: ceoAgent?.id ?? null,
    role: "ceo",
    content: `Sprint ${sprint.number} is complete. ${completedCount} tasks delivered, ${failedCount} failed. CEO will plan the next sprint.`,
    cardType: "status_update",
    cardData: null,
    createdAt: nowIso(),
  });

  setExecutionStatus("done");
}

type TagSprintResult = { ok: true } | { ok: false; error: string };

/**
 * Audit C8 (F-347): returns success/failure instead of swallowing the
 * tag error to a log-only side-channel. The caller checks `ok` before
 * flipping sprint status — a tag failure leaves the sprint recoverable
 * in `reviewing` instead of stranded in `completed` with no bundle.
 */
async function tagCurrentSprintSnapshot(): Promise<TagSprintResult> {
  const companyId = requireActiveCompanyId();
  const snapshot = await buildSnapshotView(companyId);
  const activeExecution = getActiveExecution();

  try {
    const result = await workspaceManager.tagSprint(companyId, snapshot.company.currentSprintNumber ?? 1, snapshot);
    if (result.warnings.length > 0) {
      emitEmployeeActivity("system", "info", `Sprint snapshot completed with warnings: ${result.warnings.join(" | ")}`, {
        taskId: activeExecution?.reviewTaskId ?? null,
      });
    }
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sprint snapshot failed.";
    emitEmployeeActivity("system", "error", message, {
      taskId: activeExecution?.reviewTaskId ?? null,
    });
    return { ok: false, error: message };
  }
}

/** Approve a pending board review: resolve approvals, mark execution done, and check sprint completion. */
export async function approveBoardReview() {
  const activeExecution = getActiveExecution();
  if (getExecutionStatus() !== "awaiting_board_review" || !activeExecution) {
    throw new Error("Board review is not awaiting approval.");
  }

  const reviewTaskId = activeExecution.reviewTaskId;
  const companyId = activeExecution.companyId;
  // Spec 31 Phase 7.B.3 — count via canonical instead of snapshot
  // filter. `countTasksByKindAndStatus` was added in Phase 7.A
  // exactly for this read.
  const queuedFollowUpCount = await tasksRepo.countTasksByKindAndStatus(
    getDb(), companyId, "follow_up", ["created", "planned"],
  );
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

  await updateTask(reviewTaskId, (task) => ({
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
  await checkSprintCompletion(companyId);

  return {
    executionStatus: getExecutionStatus(),
    reviewTaskId,
    queuedFollowUpCount,
    resolvedApprovalCount: resolvedApprovals.length,
  };
}
