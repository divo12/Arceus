import type { AgentIdentity, Sprint, SprintReviewState, Task } from "@arceus/contracts";
import { getAgentByRole, createWorkflowTask, nowIso } from "@arceus/task-engine";
import { appendChatMessage, updateSprint, upsertTask } from "../persistence/mutations.js";
import { requireActiveCompanyId } from "../persistence/active-company.js";
import { buildSnapshotView } from "../orchestration/snapshot-view.js";
import { emitEmployeeActivity } from "../observability/activity.js";
import {
  emitGraphDecision,
  emitGraphSprintCompleted,
  emitGraphNodeAdded,
} from "../observability/graph-emitter.js";
import { stopLocalPreview, getLocalPreviewState, startLocalPreview } from "../workspace/preview.js";
import { workspaceManager } from "../workspace/manager.js";
import { createReviewState, buildGateFailureBugFields } from "./review-helpers.js";
import { runVerificationGate } from "./verification-gate.js";
import { emitReactive } from "../orchestration/reactive.js";
import { runCrossSprintTransfer } from "../skills/cross-sprint.js";
import { swallowAndAudit } from "../observability/swallow.js";
import {
  sprintCompletionTriggered,
  setSprintCompletionTriggered,
  setExecutionStatus,
  activeExecution,
} from "../orchestration/state.js";

/**
 * Checks if all employee tasks in the current sprint have reached terminal status.
 * If so, enters the "reviewing" phase (Spec 21) instead of immediately completing.
 * Guard flag prevents double-firing.
 */
export async function checkSprintCompletion(): Promise<boolean> {
  if (sprintCompletionTriggered) return false;

  // Spec 31 Phase 7.B.4 — read snapshot via canonical-backed view.
  const companyId = requireActiveCompanyId();
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

  setSprintCompletionTriggered(true);

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

  const productDirForGate = workspaceManager.getLegacyProductDir();

  // Ensure a preview is running before the gate probes it. The workspace
  // monitor that used to auto-start previews after each developer beat is
  // not wired in this code path, so the gate would otherwise always see
  // "Preview not started" and the tester would force-fail every sprint.
  const previewBeforeGate = getLocalPreviewState();
  if (previewBeforeGate.status !== "ready" && previewBeforeGate.status !== "starting") {
    try {
      const started = await startLocalPreview(productDirForGate);
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

  const gateResult = await runVerificationGate(productDirForGate, "pre_review");

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
      emitReactive(bugFields.assignedRole, "bug_reported");
    }
  } else {
    emitEmployeeActivity("system", "transition", `Sprint ${currentSprint.number} pre-review gate PASSED — awaiting tester verification`, {
      detail: { gateResult },
    });
    reviewState.phase = "tester_verification";

    // Surface the preview URL to the user as soon as the gate passes — this
    // is the "ship it" moment from the user's POV. Tester still needs to
    // verify, but the user can poke at the preview now.
    const preview = getLocalPreviewState();
    const previewUrl = preview.url ?? preview.entryUrl ?? preview.validationUrl;
    if (previewUrl) {
      await appendChatMessage({
        id: `chat_${crypto.randomUUID()}`,
        companyId: snapshot.company.id,
        sprintId: currentSprintId,
        agentId: null,
        role: "system",
        content: `🚀 Preview ready for Sprint ${currentSprint.number}: ${previewUrl} — tester verifying now.`,
        cardType: "status_update",
        cardData: { previewUrl, sprintNumber: currentSprint.number, phase: "pre_review_passed" },
        createdAt: nowIso(),
      });
    }

    emitReactive("tester", "task_assigned");
  }

  await updateSprint(currentSprintId, (sprint) => ({
    ...sprint,
    reviewState,
  }));

  setSprintCompletionTriggered(false);
  return true;
}

/**
 * Complete the sprint after the reviewing phase is done (Spec 21).
 * Called when the final gate passes or CTO decides to skip.
 * Sets execution status to "done" so the heartbeat checklist picks up
 * the "no active sprint" condition and creates a governance task for the CEO.
 */
export async function finalizeSprintCompletion(
  sprintId: string,
): Promise<void> {
  // Spec 31 Phase 7.B.4 — read via canonical-backed view.
  const companyId = requireActiveCompanyId();
  const snapshot = await buildSnapshotView(companyId);
  const sprint = snapshot.sprints.find((s) => s.id === sprintId);
  if (!sprint) return;

  await stopLocalPreview();

  const sprintTasks = snapshot.tasks.filter(
    (t) => t.sprintId === sprintId && t.kind !== "follow_up",
  );
  const completedCount = sprintTasks.filter((t) => t.status === "completed").length;
  const failedCount = sprintTasks.filter((t) => t.status === "failed").length;
  const cancelledCount = sprintTasks.filter((t) => t.status === "cancelled").length;

  emitEmployeeActivity("system", "transition", `Sprint ${sprint.number} → COMPLETED (${completedCount}/${sprintTasks.length} delivered, ${failedCount} failed, ${cancelledCount} cancelled)`, {
    detail: { sprintNumber: sprint.number, sprintId, completedCount, failedCount, cancelledCount, totalTasks: sprintTasks.length },
  });

  await updateSprint(sprintId, (s) => ({
    ...s,
    status: "completed",
    completedAt: nowIso(),
    summary: `Sprint ${s.number} completed — ${completedCount}/${sprintTasks.length} tasks delivered.`,
    reviewState: s.reviewState ? { ...s.reviewState, phase: "complete" as const, completedAt: nowIso() } : s.reviewState,
  }));

  emitGraphSprintCompleted(sprintId, "completed");

  await tagCurrentSprintSnapshot();

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

async function tagCurrentSprintSnapshot() {
  // Spec 31 Phase 7.B.4 — read via canonical-backed view.
  // workspaceManager.tagSprint persists the full snapshot as a git
  // tag payload, so we still build the full view here.
  // requireActiveCompanyId throws when no company; the dead "company_pending"
  // string-equality guard from 7.B was retired by 7.C.1.
  const companyId = requireActiveCompanyId();
  const snapshot = await buildSnapshotView(companyId);

  try {
    const result = await workspaceManager.tagSprint(companyId, snapshot.company.currentSprintNumber ?? 1, snapshot);
    if (result.warnings.length > 0) {
      emitEmployeeActivity("system", "info", `Sprint snapshot completed with warnings: ${result.warnings.join(" | ")}`, {
        taskId: activeExecution?.reviewTaskId ?? null,
      });
    }
  } catch (error) {
    emitEmployeeActivity("system", "error", error instanceof Error ? error.message : "Sprint snapshot failed.", {
      taskId: activeExecution?.reviewTaskId ?? null,
    });
  }
}
