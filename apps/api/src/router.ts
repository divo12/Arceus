/**
 * LLM-Powered Orchestration Router
 *
 * Replaces the hardcoded 7-phase pipeline with dynamic, LLM-decided transitions.
 * After every task completion or status change, the Router decides what happens next
 * by proposing typed transitions — which are validated, recorded, and executed.
 */

import { routerConfig } from "./config/index";
import { structuredCompletion } from "./azure-openai";
import { routerDecisionSchema, type CompanySnapshot, type RouterDecision, type Task, type Transition, type TransitionProposal, type FeedbackRound } from "@arceus/contracts";
import { appendTransition, updateTransition, appendFeedbackRound, updateTask, getSnapshot } from "./store";

/* ---------- valid task status transitions ---------- */

const VALID_STATUS_TRANSITIONS: Record<Task["status"], Set<Task["status"]>> = {
  created:    new Set(["planned", "cancelled"]),
  planned:    new Set(["in_progress", "cancelled"]),
  in_progress: new Set(["verifying", "completed", "failed", "blocked", "cancelled"]),
  verifying:  new Set(["completed", "in_progress", "failed", "blocked"]),
  blocked:    new Set(["in_progress", "cancelled", "failed"]),
  completed:  new Set(["in_progress"]),  // re-open for feedback loops
  failed:     new Set(["in_progress", "cancelled"]),
  cancelled:  new Set([]),
};

/* ---------- helpers ---------- */

function nowIso() {
  return new Date().toISOString();
}

function summarizeTask(task: Task): string {
  return `[${task.id}] ${task.kind} (${task.status}) assigned=${task.assignedRole} priority=${task.priority} iter=${task.iterationCount ?? 0}/${task.maxIterations ?? 3} deps=[${task.dependsOnTaskIds.join(",")}]`;
}

function summarizeTransition(t: Transition): string {
  return `${t.fromTaskId ?? "—"}→${t.toTaskId} status=${t.toStatus} by=${t.triggeredByRole} reason="${t.reason.slice(0, 80)}"`;
}

function areDependenciesMet(task: Task, snapshot: CompanySnapshot): boolean {
  if (task.dependsOnTaskIds.length === 0) return true;
  return task.dependsOnTaskIds.every((depId) => {
    const dep = snapshot.tasks.find((t) => t.id === depId);
    return dep?.status === "completed";
  });
}

/* ---------- transition validation ---------- */

export function validateTransition(
  proposal: TransitionProposal,
  snapshot: CompanySnapshot
): { valid: boolean; reason: string } {
  const task = snapshot.tasks.find((t) => t.id === proposal.toTaskId);
  if (!task) {
    return { valid: false, reason: `Task ${proposal.toTaskId} not found` };
  }

  if (task.status === "cancelled") {
    return { valid: false, reason: `Task ${proposal.toTaskId} is cancelled and cannot transition` };
  }

  // Reject no-op same-status transitions — prevents the router from burning
  // LLM cycles proposing e.g. in_progress → in_progress repeatedly.
  if (task.status === proposal.toStatus) {
    return { valid: false, reason: `Task ${proposal.toTaskId} is already ${task.status} — no-op transition rejected` };
  }

  if (task.kind === "follow_up") {
    return { valid: false, reason: `Follow-up tasks are not executed during sprints — they are CEO context for sprint proposals` };
  }

  const allowed = VALID_STATUS_TRANSITIONS[task.status];
  if (!allowed?.has(proposal.toStatus)) {
    return { valid: false, reason: `Invalid status transition: ${task.status} → ${proposal.toStatus}` };
  }

  // dependency check for moving to in_progress
  if (proposal.toStatus === "in_progress" && !areDependenciesMet(task, snapshot)) {
    return { valid: false, reason: `Dependencies not met for ${proposal.toTaskId}` };
  }

  // feedback loop iteration guard
  if (proposal.toStatus === "in_progress" && task.status === "completed") {
    const iterations = task.iterationCount ?? 0;
    const maxIterations = task.maxIterations ?? routerConfig.maxFeedbackIterations;
    if (iterations >= maxIterations) {
      return { valid: false, reason: `Task ${proposal.toTaskId} exceeded max iterations (${maxIterations})` };
    }
  }

  return { valid: true, reason: "ok" };
}

/* ---------- transition execution ---------- */

export function executeTransition(
  proposal: TransitionProposal,
  snapshot: CompanySnapshot,
  executionStatus: string
): Transition {
  const transitionId = `transition_${crypto.randomUUID()}`;
  const task = snapshot.tasks.find((t) => t.id === proposal.toTaskId)!;

  const transition: Transition = {
    id: transitionId,
    companyId: snapshot.company.id,
    fromTaskId: proposal.fromTaskId,
    toTaskId: proposal.toTaskId,
    fromStatus: task.status,
    toStatus: proposal.toStatus,
    triggeredByRole: proposal.triggeredByRole,
    reason: proposal.reason,
    artifactIds: proposal.artifactIds,
    status: "executed",
    executionStatus: executionStatus as Transition["executionStatus"],
    createdAt: nowIso(),
    executedAt: nowIso(),
  };

  // record transition
  appendTransition(transition);

  // apply task status change
  const isReopen = task.status === "completed" && proposal.toStatus === "in_progress";
  updateTask(proposal.toTaskId, (t) => ({
    ...t,
    status: proposal.toStatus,
    iterationCount: isReopen ? (t.iterationCount ?? 0) + 1 : (t.iterationCount ?? 0),
    incomingArtifactIds: proposal.artifactIds.length > 0
      ? [...(t.incomingArtifactIds ?? []), ...proposal.artifactIds]
      : (t.incomingArtifactIds ?? []),
    startedAt: proposal.toStatus === "in_progress" && !t.startedAt ? nowIso() : t.startedAt,
    completedAt: proposal.toStatus === "completed" ? nowIso() : (proposal.toStatus === "in_progress" ? null : t.completedAt),
  }));

  // if it's a feedback loop re-open, also create a FeedbackRound record
  if (isReopen) {
    const round: FeedbackRound = {
      id: `feedback_${crypto.randomUUID()}`,
      companyId: snapshot.company.id,
      taskId: proposal.toTaskId,
      iteration: (task.iterationCount ?? 0) + 1,
      fromRole: proposal.triggeredByRole,
      toRole: task.assignedRole,
      verdict: "revise",
      feedback: proposal.reason,
      artifactIds: proposal.artifactIds,
      createdAt: nowIso(),
    };
    appendFeedbackRound(round);
  }

  // Auto-promote: when a task completes, check if downstream tasks can move from created → planned
  if (proposal.toStatus === "completed") {
    autoPromoteReadyTasks();
  }

  return transition;
}

/**
 * Scan all tasks: if a task is "created" and all its dependencies are "completed",
 * promote it to "planned" so the router can propose starting it.
 * This removes the need for the LLM to propose created → planned transitions.
 */
function autoPromoteReadyTasks() {
  const snapshot = getSnapshot();
  for (const task of snapshot.tasks) {
    if (task.status !== "created") continue;
    if (task.kind === "follow_up") continue; // Follow-ups are CEO context, not execution targets
    if (!areDependenciesMet(task, snapshot)) continue;
    updateTask(task.id, (t) => ({ ...t, status: "planned" as const }));
  }
}

/* ---------- LLM Router: propose next transitions ---------- */

function buildRouterUserPrompt(snapshot: CompanySnapshot, executionStatus: string, recentEvent: string): string {
  // Only show current sprint tasks to the router — prevents Sprint 1 tasks leaking into Sprint 2 decisions
  const currentSprintId = snapshot.company.currentSprintId;
  const taskSummary = snapshot.tasks
    .filter((t) => t.status !== "cancelled" && t.kind !== "follow_up" && (!currentSprintId || t.sprintId === currentSprintId))
    .map(summarizeTask)
    .join("\n");

  const transitions = snapshot.transitions ?? [];
  const recent = transitions.slice(-10);
  const recentTransitions = recent.length > 0
    ? recent.map(summarizeTransition).join("\n")
    : "(none yet)";

  const rounds = snapshot.feedbackRounds ?? [];
  const feedbackSummary = rounds.length > 0
    ? rounds.slice(-5).map((r) => `iter=${r.iteration} ${r.fromRole}→${r.toRole}: ${r.verdict} "${r.feedback.slice(0, 80)}"`).join("\n")
    : "(no feedback yet)";

  return routerConfig.prompts.userTemplate
    .replace("{{executionStatus}}", executionStatus)
    .replace("{{recentEvent}}", recentEvent)
    .replace("{{taskSummary}}", taskSummary)
    .replace("{{recentTransitions}}", recentTransitions)
    .replace("{{feedbackSummary}}", feedbackSummary);
}

export async function proposeNextTransitions(
  snapshot: CompanySnapshot,
  executionStatus: string,
  recentEvent: string
): Promise<RouterDecision> {
  const userPrompt = buildRouterUserPrompt(snapshot, executionStatus, recentEvent);

  const decision = await structuredCompletion(
    "workerDeployment",
    [
      { role: "system", content: routerConfig.prompts.system },
      { role: "user", content: userPrompt },
    ],
    routerDecisionSchema,
    "router_decision",
    { temperature: 0.4 }
  );

  return decision;
}

/* ---------- Router Loop: the main autonomous engine ---------- */

export type RouterLoopResult = {
  transitionsExecuted: Transition[];
  paused: boolean;
  pauseReason: string | null;
  cycleCount: number;
};

/**
 * The core autonomous loop. Keeps asking the LLM Router "what next?" and
 * executing valid transitions until:
 *   - Router says shouldPause=true (board input needed)
 *   - All tasks are completed/cancelled
 *   - Max transitions per cycle reached (safety valve)
 *   - No valid transitions proposed (stuck)
 */
export async function runRouterLoop(
  executionStatus: string,
  triggerEvent: string,
  onTransition?: (transition: Transition, snapshot: CompanySnapshot) => void | Promise<void>,
  shouldYield?: (task: Task, proposal: TransitionProposal) => boolean
): Promise<RouterLoopResult> {
  const result: RouterLoopResult = {
    transitionsExecuted: [],
    paused: false,
    pauseReason: null,
    cycleCount: 0,
  };

  let currentEvent = triggerEvent;
  let consecutiveRejections = 0;

  for (let cycle = 0; cycle < routerConfig.maxTransitionsPerCycle; cycle++) {
    result.cycleCount = cycle + 1;
    const snapshot = getSnapshot();

    // check if all current sprint tasks are done
    const currentSprintId = snapshot.company.currentSprintId;
    const activeTasks = snapshot.tasks.filter((t) =>
      t.kind !== "follow_up" &&
      !["completed", "cancelled", "failed"].includes(t.status) &&
      (!currentSprintId || t.sprintId === currentSprintId)
    );
    if (activeTasks.length === 0) {
      result.pauseReason = "All tasks completed";
      break;
    }

    // ask the LLM Router
    const decision = await proposeNextTransitions(snapshot, executionStatus, currentEvent);

    console.log(`[Router] Cycle ${cycle}: shouldPause=${decision.shouldPause}, transitions=${decision.transitions.length}, pauseReason=${decision.pauseReason ?? "none"}`);
    for (const t of decision.transitions) {
      console.log(`[Router]   → ${t.toTaskId?.substring(0, 20)} to ${t.toStatus} (confidence=${t.confidence}, role=${t.triggeredByRole})`);
    }

    if (decision.shouldPause) {
      result.paused = true;
      result.pauseReason = decision.pauseReason;
      break;
    }

    let anyExecuted = false;
    const rejectionReasons: string[] = [];

    for (const proposal of decision.transitions) {
      const freshSnapshot = getSnapshot();
      const validation = validateTransition(proposal, freshSnapshot);

      if (!validation.valid) {
        console.warn(`[Router] Rejected transition: ${validation.reason}`);
        rejectionReasons.push(`${proposal.toTaskId} → ${proposal.toStatus}: ${validation.reason}`);
        continue;
      }

      // check if this transition needs to yield for async work (e.g., developer session)
      const task = freshSnapshot.tasks.find((t) => t.id === proposal.toTaskId);
      if (task && shouldYield?.(task, proposal)) {
        // execute the status change but return so the orchestrator can handle the async work
        const transition = executeTransition(proposal, freshSnapshot, executionStatus);
        result.transitionsExecuted.push(transition);
        if (onTransition) await onTransition(transition, getSnapshot());
        anyExecuted = true;
        // yield control — the caller will re-enter the router loop after async work completes
        result.paused = true;
        result.pauseReason = `Yielding for async work on task ${task.id} (${task.kind})`;
        return result;
      }

      // if low confidence, mark as requiring approval
      if (proposal.confidence < routerConfig.confidenceThreshold) {
        console.warn(`[Router] Low confidence (${proposal.confidence}) on transition to ${proposal.toTaskId}, requiring approval`);
        const transition: Transition = {
          id: `transition_${crypto.randomUUID()}`,
          companyId: freshSnapshot.company.id,
          fromTaskId: proposal.fromTaskId,
          toTaskId: proposal.toTaskId,
          fromStatus: freshSnapshot.tasks.find((t) => t.id === proposal.toTaskId)?.status ?? null,
          toStatus: proposal.toStatus,
          triggeredByRole: proposal.triggeredByRole,
          reason: proposal.reason,
          artifactIds: proposal.artifactIds,
          status: "proposed",
          executionStatus: executionStatus as Transition["executionStatus"],
          createdAt: nowIso(),
          executedAt: null,
        };
        appendTransition(transition);
        result.transitionsExecuted.push(transition);
        continue;
      }

      const transition = executeTransition(proposal, freshSnapshot, executionStatus);
      result.transitionsExecuted.push(transition);
      anyExecuted = true;

      if (onTransition) await onTransition(transition, getSnapshot());

      currentEvent = `Executed transition: ${proposal.toTaskId} → ${proposal.toStatus} (${proposal.reason.slice(0, 60)})`;
    }

    if (!anyExecuted) {
      if (rejectionReasons.length > 0) {
        consecutiveRejections++;
        if (consecutiveRejections >= 3) {
          result.paused = true;
          result.pauseReason = `Router stuck after ${consecutiveRejections} consecutive rejected cycles. Last rejections: ${rejectionReasons.join("; ")}`;
          break;
        }
        // Feed rejection reasons back so the router can propose different transitions
        currentEvent = `Previous proposals were rejected: ${rejectionReasons.join("; ")}. Propose different valid transitions for tasks whose dependencies are already met.`;
        continue;
      }
      result.pauseReason = "No valid transitions could be executed";
      break;
    } else {
      consecutiveRejections = 0;
    }
  }

  return result;
}
