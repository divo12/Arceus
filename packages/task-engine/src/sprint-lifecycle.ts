import type { Task, Sprint, CompanySnapshot } from "@arceus/contracts";
import { createSprintObject, createWorkflowTask, nowIso, getAgentByRole } from "./task-helpers";
import type { AuditEntry } from "./task-state-machine";

// ---------------------------------------------------------------------------
// Dependency-injection interfaces
// ---------------------------------------------------------------------------

export interface CreateSprintCallbacks {
  /** Spec 31 Phase 7.C.d — async to write to canonical. */
  upsertSprint: (sprint: Sprint) => Promise<Sprint> | Sprint;
  /** Caller passes companyId via closure since this deps object is
   *  request-scoped and the company is fixed for the operation. */
  updateCompanySprint: (sprintId: string, number: number) => Promise<void> | void;
  emitReactiveBroadcast: (event: string) => void;
}

export interface CheckSprintCompletionCallbacks {
  /** Spec 31 Phase 7.C.b — async to read from canonical. */
  getSnapshot: () => Promise<CompanySnapshot>;
  emitEmployeeActivity: (role: string, type: string, message: string, detail: { detail: Record<string, unknown>; taskId?: string | null }) => void;
  emitGraphDecision?: (sprintId: string, taskId: string | null, type: string, title: string, detail: string, role: string, confidence: number) => void;
  emitGraphNodeAdded?: (sprintId: string, task: Task) => void;
  createReviewState: (maxCycles: number) => Record<string, unknown>;
  updateSprint: (id: string, updater: (s: Sprint) => Sprint) => void;
  getProductDir: () => string;
  runVerificationGate: (dir: string, phase: string) => Promise<{ passed: boolean; buildResult?: { stderr?: string } | null }>;
  buildGateFailureBugFields: (result: { passed: boolean; buildResult?: { stderr?: string } | null }, sprintId: string) => {
    kind: Task["kind"];
    assignedRole: Task["assignedRole"];
    title: string;
    description: string;
    problemStatement: string;
    deliverable: string;
    definitionOfDone: string[];
    priority: Task["priority"];
    sprintId: string | null;
  } | null;
  upsertTask: (task: Task) => void;
  emitReactive: (role: string, event: string) => void;
}

export interface FinalizeSprintCallbacks {
  /** Spec 31 Phase 7.C.b — async to read from canonical. */
  getSnapshot: () => Promise<CompanySnapshot>;
  stopLocalPreview: () => Promise<void>;
  emitEmployeeActivity: (role: string, type: string, message: string, detail: { detail: Record<string, unknown>; taskId?: string | null }) => void;
  updateSprint: (id: string, updater: (s: Sprint) => Sprint) => void;
  emitGraphSprintCompleted?: (sprintId: string, status: string) => void;
  tagCurrentSprintSnapshot: () => Promise<void>;
  runCrossSprintTransfer: (companyId: string, sprintId: string) => Promise<{ candidatesFound: number; mutationsProposed: number; mutationsRefused: number }>;
  appendChatMessage: (msg: {
    id: string;
    companyId: string;
    sprintId: string;
    agentId: string | null;
    role: string;
    content: string;
    cardType: string;
    cardData: null;
    createdAt: string;
  }) => void;
}

// ---------------------------------------------------------------------------
// Sprint lifecycle functions
// ---------------------------------------------------------------------------

/**
 * Create and persist a new sprint record.
 * Side effects (store, event) are injected via callbacks.
 */
export async function createSprintRecord(
  cb: CreateSprintCallbacks,
  snapshot: CompanySnapshot,
  title: string,
  goal: string,
): Promise<Sprint> {
  const sprint = createSprintObject(snapshot, title, goal);

  await cb.upsertSprint(sprint);
  await cb.updateCompanySprint(sprint.id, sprint.number);
  cb.emitReactiveBroadcast("sprint_started");

  return sprint;
}

/**
 * Pure check: are all non-followup/bugfix tasks in a sprint terminal?
 * Returns the terminal status and a breakdown by status.
 */
export function isSprintComplete(
  snapshot: CompanySnapshot,
  sprintId: string,
): { allTerminal: boolean; statusCounts: Record<string, number>; taskCount: number } {
  const sprintTasks = snapshot.tasks.filter(
    (t) => t.sprintId === sprintId && t.kind !== "follow_up" && t.kind !== "bug_fix",
  );

  const statusCounts: Record<string, number> = {};
  for (const t of sprintTasks) {
    statusCounts[t.status] = (statusCounts[t.status] || 0) + 1;
  }

  const allTerminal = sprintTasks.length > 0 && sprintTasks.every((t) =>
    ["completed", "cancelled", "failed"].includes(t.status),
  );

  return { allTerminal, statusCounts, taskCount: sprintTasks.length };
}

/**
 * Check if the current sprint is complete and transition it to "reviewing".
 *
 * Manages the review gate: runs verification, creates bug tasks on failure,
 * or advances to tester verification on success.
 *
 * Returns `true` if the sprint was transitioned.
 */
export async function checkSprintCompletion(
  cb: CheckSprintCompletionCallbacks,
  guard: { triggered: boolean },
): Promise<boolean> {
  if (guard.triggered) return false;

  const snapshot = await cb.getSnapshot();
  const currentSprintId = snapshot.company.currentSprintId;
  if (!currentSprintId) return false;

  const currentSprint = snapshot.sprints.find((s) => s.id === currentSprintId);
  if (!currentSprint || currentSprint.status === "completed" || currentSprint.status === "reviewing") return false;

  const { allTerminal, statusCounts, taskCount } = isSprintComplete(snapshot, currentSprintId);
  if (taskCount === 0) return false;

  if (!allTerminal) {
    cb.emitEmployeeActivity("system", "context", `Sprint ${currentSprint.number} completion check: NOT all terminal — ${JSON.stringify(statusCounts)}`, {
      detail: { sprintNumber: currentSprint.number, totalTasks: taskCount, statusCounts },
    });
    return false;
  }

  guard.triggered = true;

  // Enter sprint reviewing phase
  cb.emitEmployeeActivity("system", "transition", `Sprint ${currentSprint.number} → REVIEWING (all implementation tasks terminal)`, {
    detail: { sprintNumber: currentSprint.number, sprintId: currentSprintId },
  });

  cb.emitGraphDecision?.(currentSprintId, null, "task_completion",
    `Sprint ${currentSprint.number} → REVIEWING`,
    `All ${taskCount} implementation tasks reached terminal status`,
    "system", 1.0);

  const reviewState = cb.createReviewState(3);

  cb.updateSprint(currentSprintId, (sprint) => ({
    ...sprint,
    status: "reviewing" as Sprint["status"],
    reviewState: reviewState as Sprint["reviewState"],
  }));

  // Run pre-review build gate
  const productDir = cb.getProductDir();
  const gateResult = await cb.runVerificationGate(productDir, "pre_review");

  cb.emitGraphDecision?.(currentSprintId, null, "gate_verdict",
    `Pre-review gate: ${gateResult.passed ? "PASSED" : "FAILED"}`,
    gateResult.passed
      ? "Build check passed"
      : `Build check failed: ${gateResult.buildResult?.stderr?.slice(0, 200) ?? "unknown error"}`,
    "system", gateResult.passed ? 1.0 : 0);

  (reviewState as Record<string, unknown[]>).gateResults.push(gateResult);

  if (!gateResult.passed) {
    cb.emitEmployeeActivity("system", "transition", `Sprint ${currentSprint.number} pre-review gate FAILED — creating build fix task`, {
      detail: { gateResult },
    });

    const bugFields = cb.buildGateFailureBugFields(gateResult, currentSprintId);
    if (bugFields) {
      // Reuse the snapshot we already fetched at the top of this function
      // — `createWorkflowTask` only reads fields that are stable across the
      // intervening operations (verification gate). One read per beat.
      const bugTask = createWorkflowTask(
        snapshot, bugFields.kind, bugFields.assignedRole,
        bugFields.title, bugFields.description, bugFields.problemStatement,
        bugFields.deliverable, bugFields.definitionOfDone, bugFields.priority, "planned",
        bugFields.sprintId,
      );
      cb.upsertTask(bugTask);
      (reviewState as Record<string, unknown[]>).bugTaskIds.push(bugTask.id);
      (reviewState as Record<string, string>).phase = "rework";

      cb.emitGraphNodeAdded?.(currentSprintId, bugTask);
      cb.emitReactive(bugFields.assignedRole, "bug_reported");
    }
  } else {
    cb.emitEmployeeActivity("system", "transition", `Sprint ${currentSprint.number} pre-review gate PASSED — awaiting tester verification`, {
      detail: { gateResult },
    });
    (reviewState as Record<string, string>).phase = "tester_verification";
    cb.emitReactive("tester", "task_assigned");
  }

  // Persist the updated review state
  cb.updateSprint(currentSprintId, (sprint) => ({
    ...sprint,
    reviewState: reviewState as Sprint["reviewState"],
  }));

  guard.triggered = false;
  return true;
}

/**
 * Finalize sprint completion: stop preview, persist snapshot, trigger
 * cross-sprint transfer, notify CEO, and propose the next sprint.
 */
export async function finalizeSprintCompletion(
  cb: FinalizeSprintCallbacks,
  sprintId: string,
): Promise<void> {
  const snapshot = await cb.getSnapshot();
  const sprint = snapshot.sprints.find((s) => s.id === sprintId);
  if (!sprint) return;

  await cb.stopLocalPreview();

  const sprintTasks = snapshot.tasks.filter(
    (t) => t.sprintId === sprintId && t.kind !== "follow_up",
  );
  const completedCount = sprintTasks.filter((t) => t.status === "completed").length;
  const failedCount = sprintTasks.filter((t) => t.status === "failed").length;
  const cancelledCount = sprintTasks.filter((t) => t.status === "cancelled").length;

  cb.emitEmployeeActivity("system", "transition",
    `Sprint ${sprint.number} → COMPLETED (${completedCount}/${sprintTasks.length} delivered, ${failedCount} failed, ${cancelledCount} cancelled)`, {
      detail: { sprintNumber: sprint.number, sprintId, completedCount, failedCount, cancelledCount, totalTasks: sprintTasks.length },
    });

  cb.updateSprint(sprintId, (s) => ({
    ...s,
    status: "completed" as Sprint["status"],
    completedAt: nowIso(),
    summary: `Sprint ${s.number} completed — ${completedCount}/${sprintTasks.length} tasks delivered.`,
    reviewState: s.reviewState ? { ...s.reviewState, phase: "complete" as const, completedAt: nowIso() } : s.reviewState,
  }));

  cb.emitGraphSprintCompleted?.(sprintId, "completed");

  await cb.tagCurrentSprintSnapshot();

  // Spec 14 Phase 6: cross-sprint pattern transfer (fire-and-forget)
  cb.runCrossSprintTransfer(snapshot.company.id, sprintId).then((result) => {
    if (result.candidatesFound > 0) {
      console.log(`[CrossSprintTransfer] Sprint ${sprint.number}: ${result.candidatesFound} candidates, ${result.mutationsProposed} proposed, ${result.mutationsRefused} refused`);
    }
  }).catch((err) => {
    console.warn(`[CrossSprintTransfer] Sprint transfer error: ${err instanceof Error ? err.message : err}`);
  });

  const ceoAgent = getAgentByRole(snapshot, "ceo");
  cb.appendChatMessage({
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
}
