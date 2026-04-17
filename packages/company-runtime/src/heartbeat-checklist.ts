/**
 * Heartbeat Role Checklists — Spec 12 Phase 2
 *
 * Each role has a checklist that runs during the Observation phase
 * of every beat. The checklist determines whether the agent has
 * actionable work (action_needed) or can skip (ok).
 *
 * CheckResult.status:
 *   ok             → nothing to do for this check
 *   action_needed  → work available, beat should proceed to Execute
 *   blocked        → cannot proceed, beat should record and skip
 */

import type {
  AgentBeatContext,
  CheckResult,
  AgentIdentity,
} from "@arceus/contracts";

// ── Individual check functions ─────────────────────────────

function checkPendingApprovals(ctx: AgentBeatContext): CheckResult {
  const pending = ctx.approvals.filter((a) => a.status === "pending");
  if (pending.length === 0) return { status: "ok", detail: "No pending approvals" };
  return {
    status: "action_needed",
    detail: `${pending.length} pending approval(s)`,
    suggestedAction: `Review approval: ${pending[0].title}`,
  };
}

function checkBudgetHealth(ctx: AgentBeatContext): CheckResult {
  if (ctx.companyBudgetRemainingCents <= 0) {
    return { status: "blocked", detail: "Budget exhausted", suggestedAction: "Pause work — budget is 0" };
  }
  const usedPct = ((ctx.company.spentCents / ctx.company.budgetCents) * 100).toFixed(1);
  if (ctx.company.spentCents > ctx.company.budgetCents * 0.9) {
    return { status: "action_needed", detail: `Budget at ${usedPct}%`, suggestedAction: "Review spending" };
  }
  return { status: "ok", detail: `Budget at ${usedPct}%` };
}

function checkSprintHealth(ctx: AgentBeatContext): CheckResult {
  if (!ctx.currentSprint) {
    return { status: "ok", detail: "No active sprint" };
  }
  const blocked = ctx.tasks.filter((t) => t.status === "blocked");
  const failed = ctx.tasks.filter((t) => t.status === "failed");
  if (blocked.length > 0 || failed.length > 0) {
    return {
      status: "action_needed",
      detail: `Sprint has ${blocked.length} blocked, ${failed.length} failed tasks`,
      suggestedAction: "Investigate blocked/failed tasks",
    };
  }
  return { status: "ok", detail: "Sprint healthy" };
}

function checkRoadmap(ctx: AgentBeatContext): CheckResult {
  // CEO proactive: if sprint is complete or no sprint, propose next
  if (!ctx.currentSprint) {
    return { status: "action_needed", detail: "No active sprint", suggestedAction: "Propose new sprint" };
  }
  if (ctx.currentSprint.status === "completed" || ctx.currentSprint.status === "reviewing") {
    return {
      status: "action_needed",
      detail: `Sprint ${ctx.currentSprint.number} is ${ctx.currentSprint.status}`,
      suggestedAction: "Propose next sprint or summarize results",
    };
  }
  // Detect all tasks terminal even if sprint status hasn't been updated yet
  const sprintTasks = ctx.tasks.filter((t) => t.sprintId === ctx.currentSprint!.id);
  if (sprintTasks.length > 0 && sprintTasks.every((t) => ["completed", "failed", "cancelled", "blocked"].includes(t.status))) {
    return {
      status: "action_needed",
      detail: `All ${sprintTasks.length} tasks in sprint ${ctx.currentSprint.number} are terminal`,
      suggestedAction: "Propose next sprint",
    };
  }
  return { status: "ok", detail: "Sprint in progress" };
}

function checkReviewQueue(ctx: AgentBeatContext): CheckResult {
  // CTO: check for tasks in verifying state that need review
  const verifying = ctx.tasks.filter((t) => t.status === "verifying");
  if (verifying.length > 0) {
    return {
      status: "action_needed",
      detail: `${verifying.length} task(s) awaiting review`,
      suggestedAction: `Review task: ${verifying[0].title}`,
    };
  }
  return { status: "ok", detail: "No tasks awaiting review" };
}

function checkBuildStatus(ctx: AgentBeatContext): CheckResult {
  const build = ctx.lastBuildCheck;
  if (!build || build.status === "unknown") {
    return { status: "ok", detail: "Build check not yet run" };
  }
  if (build.status === "error") {
    return {
      status: "action_needed",
      detail: `Build failing: ${build.detail.slice(0, 200)}`,
      suggestedAction: "Fix build errors before continuing",
    };
  }
  return { status: "ok", detail: build.detail };
}

function checkDevProgress(ctx: AgentBeatContext): CheckResult {
  const inProgress = ctx.tasks.filter(
    (t) => t.status === "in_progress" && t.assignedRole === "developer"
  );
  const stale = inProgress.filter((t) => {
    // Consider stale if no progress tracked and started > 10 min ago
    if (!t.startedAt) return false;
    const elapsed = Date.now() - new Date(t.startedAt).getTime();
    return elapsed > 10 * 60 * 1000;
  });
  if (stale.length > 0) {
    return {
      status: "action_needed",
      detail: `${stale.length} dev task(s) possibly stale`,
      suggestedAction: "Check on developer progress",
    };
  }
  return { status: "ok", detail: `${inProgress.length} dev task(s) in progress` };
}

function checkAssignedTasks(ctx: AgentBeatContext): CheckResult {
  const actionable = ctx.tasks.filter(
    (t) => t.status === "planned" || t.status === "created" || t.status === "in_progress"
  );
  if (actionable.length === 0) {
    return { status: "ok", detail: "No actionable tasks" };
  }
  // Prioritize: in_progress first, then planned, then created
  const next =
    actionable.find((t) => t.status === "in_progress") ??
    actionable.find((t) => t.status === "planned") ??
    actionable[0];
  return {
    status: "action_needed",
    detail: `${actionable.length} actionable task(s)`,
    suggestedAction: `Work on: ${next.title} (${next.status})`,
  };
}

function checkDependenciesMet(ctx: AgentBeatContext): CheckResult {
  // Check if any of this agent's tasks have unmet dependencies
  const blocked = ctx.tasks.filter((t) => {
    if (t.status !== "planned" && t.status !== "created") return false;
    return t.dependsOnTaskIds.some((depId) => {
      const dep = ctx.tasks.find((d) => d.id === depId);
      // If dep is not in our task list, look it up in the broader context
      return dep ? dep.status !== "completed" : false;
    });
  });
  if (blocked.length > 0) {
    return {
      status: "blocked",
      detail: `${blocked.length} task(s) waiting on dependencies`,
      suggestedAction: "Wait for upstream tasks to complete",
    };
  }
  return { status: "ok", detail: "All dependencies met" };
}

function checkBoardMessages(ctx: AgentBeatContext): CheckResult {
  if (ctx.recentBoardMessages.length === 0) return { status: "ok", detail: "No recent board messages" };
  // Check for unanswered board messages (board role only)
  const boardOnly = ctx.recentBoardMessages.filter((m) => m.role === "board");
  if (boardOnly.length > 0) {
    return {
      status: "action_needed",
      detail: `${boardOnly.length} recent board message(s)`,
      suggestedAction: "Respond to board",
    };
  }
  return { status: "ok", detail: "Board messages handled" };
}

function checkScopeControl(ctx: AgentBeatContext): CheckResult {
  // PM: ensure no unplanned tasks or scope creep
  const unplanned = ctx.tasks.filter((t) => !t.sprintId && t.status !== "cancelled");
  if (unplanned.length > 0) {
    return {
      status: "action_needed",
      detail: `${unplanned.length} task(s) not assigned to any sprint`,
      suggestedAction: "Triage unplanned tasks",
    };
  }
  return { status: "ok", detail: "Scope is clean" };
}

function checkTestQueue(ctx: AgentBeatContext): CheckResult {
  const readyForTest = ctx.tasks.filter(
    (t) => t.status === "verifying" && t.assignedRole === "tester"
  );
  if (readyForTest.length > 0) {
    return {
      status: "action_needed",
      detail: `${readyForTest.length} task(s) ready for testing`,
      suggestedAction: `Test: ${readyForTest[0].title}`,
    };
  }
  return { status: "ok", detail: "No tasks to test" };
}

// ── Spec 21: Sprint Verification Checks ────────────────────

/**
 * Tester check: is the sprint in "reviewing" and waiting for tester verification?
 * Fires when reviewState.phase is "tester_verification" or "final_gate".
 */
function checkReviewPhaseActive(ctx: AgentBeatContext): CheckResult {
  const sprint = ctx.currentSprint;
  if (!sprint || sprint.status !== "reviewing") return { status: "ok", detail: "Sprint not in review" };

  const reviewState = (sprint as any).reviewState;
  if (!reviewState) return { status: "ok", detail: "No review state" };

  if (reviewState.phase === "tester_verification") {
    return {
      status: "action_needed",
      detail: `Sprint ${sprint.number} awaiting tester verification (cycle ${reviewState.reworkCycleCount})`,
      suggestedAction: "sprint_review:run_tester_verification",
    };
  }

  if (reviewState.phase === "final_gate") {
    return {
      status: "action_needed",
      detail: `Sprint ${sprint.number} awaiting final gate`,
      suggestedAction: "sprint_review:run_final_gate",
    };
  }

  return { status: "ok", detail: `Review phase: ${reviewState.phase}` };
}

/**
 * Tester check: have all bug_fix tasks been resolved?
 * When the sprint is in "rework" phase and all bug_fix tasks are terminal,
 * triggers the tester to re-verify.
 */
function checkBugFixesReady(ctx: AgentBeatContext): CheckResult {
  const sprint = ctx.currentSprint;
  if (!sprint || sprint.status !== "reviewing") return { status: "ok", detail: "Sprint not in review" };

  const reviewState = (sprint as any).reviewState;
  if (!reviewState || reviewState.phase !== "rework") return { status: "ok", detail: "Not in rework phase" };

  const bugTaskIds: string[] = reviewState.bugTaskIds ?? [];
  if (bugTaskIds.length === 0) return { status: "ok", detail: "No bug tasks tracked" };

  // Check if ALL bug_fix tasks are terminal
  const allResolved = bugTaskIds.every((id: string) => {
    const task = ctx.tasks.find((t) => t.id === id);
    if (!task) return true; // missing counts as resolved
    return ["completed", "cancelled", "failed"].includes(task.status);
  });

  if (allResolved) {
    return {
      status: "action_needed",
      detail: `All ${bugTaskIds.length} bug fix(es) resolved — ready for re-verification`,
      suggestedAction: "sprint_review:retest_after_rework",
    };
  }

  const remaining = bugTaskIds.filter((id: string) => {
    const task = ctx.tasks.find((t) => t.id === id);
    return task && !["completed", "cancelled", "failed"].includes(task.status);
  });
  return { status: "ok", detail: `${remaining.length} bug fix(es) still pending` };
}

// ── Spec 21: CTO Escalation Check ─────────────────────────

/**
 * CTO check: has the sprint been escalated after max rework cycles?
 * Fires when reviewState.escalatedToCto === true and ctoDecision is null.
 */
function checkEscalationPending(ctx: AgentBeatContext): CheckResult {
  const sprint = ctx.currentSprint;
  if (!sprint || sprint.status !== "reviewing") return { status: "ok", detail: "Sprint not in review" };

  const reviewState = (sprint as any).reviewState;
  if (!reviewState) return { status: "ok", detail: "No review state" };

  if (reviewState.escalatedToCto === true && reviewState.ctoDecision === null) {
    return {
      status: "action_needed",
      detail: `Sprint ${sprint.number} escalated after ${reviewState.reworkCycleCount} rework cycles — awaiting CTO decision (fix/skip/abort)`,
      suggestedAction: "sprint_review:cto_escalation_review",
    };
  }

  return { status: "ok", detail: "No pending escalation" };
}

function checkDesignQueue(ctx: AgentBeatContext): CheckResult {
  const designTasks = ctx.tasks.filter(
    (t) => (t.status === "planned" || t.status === "in_progress") && t.assignedRole === "ui_designer"
  );
  if (designTasks.length > 0) {
    return {
      status: "action_needed",
      detail: `${designTasks.length} design task(s)`,
      suggestedAction: `Design: ${designTasks[0].title}`,
    };
  }
  return { status: "ok", detail: "No design work queued" };
}

function checkContentQueue(ctx: AgentBeatContext): CheckResult {
  const contentTasks = ctx.tasks.filter(
    (t) => (t.status === "planned" || t.status === "in_progress") && t.assignedRole === "marketing"
  );
  if (contentTasks.length > 0) {
    return {
      status: "action_needed",
      detail: `${contentTasks.length} content task(s)`,
      suggestedAction: `Create: ${contentTasks[0].title}`,
    };
  }
  return { status: "ok", detail: "No marketing tasks" };
}

function checkSkillQueue(ctx: AgentBeatContext): CheckResult {
  const skillTasks = ctx.tasks.filter(
    (t) => (t.status === "planned" || t.status === "in_progress") && t.assignedRole === "skills_lead"
  );
  if (skillTasks.length > 0) {
    return {
      status: "action_needed",
      detail: `${skillTasks.length} skill task(s)`,
      suggestedAction: `Author: ${skillTasks[0].title}`,
    };
  }
  return { status: "ok", detail: "No skill tasks" };
}

// ── Spec 18: Meeting contribution check ────────────────────

/**
 * Check if this agent needs to contribute to a meeting currently in "collecting" status.
 * Returns action_needed with the meeting ID so the beat executor can produce a contribution.
 */
function checkMeetingContribution(ctx: AgentBeatContext): CheckResult {
  const collectingMeeting = ctx.recentMeetings.find(
    (m) => m.status === "collecting" && m.participantAgentIds.includes(ctx.agentId),
  );
  if (!collectingMeeting) return { status: "ok", detail: "No meeting awaiting contribution" };

  // Check if we already contributed
  const alreadyContributed = collectingMeeting.contributions.some((c) => c.agentId === ctx.agentId);
  if (alreadyContributed) return { status: "ok", detail: "Already contributed to meeting" };

  return {
    status: "action_needed",
    detail: `Meeting "${collectingMeeting.title}" awaiting your contribution`,
    suggestedAction: `meeting_contribution:${collectingMeeting.id}`,
  };
}

// ── Spec 14 Phase 6: Skills Lead proactive checks ─────────

/**
 * Skills Lead — flag skills with successRate < 0.6 for mutation.
 * The beat handler picks the worst-performing one and routes it to
 * Phase 2 failure-attribution → mutation proposal.
 *
 * Data flows through ctx.skillHealth (injected by loadAgentContext).
 */
function checkSkillHealth(ctx: AgentBeatContext): CheckResult {
  const health = ctx.skillHealth;
  if (!health || health.worstPerformers.length === 0) {
    return { status: "ok", detail: "All skills healthy" };
  }
  const worst = health.worstPerformers[0];
  return {
    status: "action_needed",
    detail: `${health.worstPerformers.length} underperforming skill(s), worst: ${worst.name} (${Math.round(worst.successRate * 100)}%)`,
    suggestedAction: "skills_lead:mutate_underperformer",
  };
}

/**
 * Skills Lead — flag skills that have not been used for 30+ days.
 * The beat handler proposes deprecation via an ATA-gated mutation
 * (so the system can veto if the skill is actually valuable).
 */
function checkUnusedSkills(ctx: AgentBeatContext): CheckResult {
  const unused = ctx.unusedSkills ?? [];
  if (unused.length === 0) {
    return { status: "ok", detail: "No stale skills" };
  }
  return {
    status: "action_needed",
    detail: `${unused.length} skill(s) unused for 30+ days`,
    suggestedAction: "skills_lead:deprecate_unused",
  };
}

/**
 * Skills Lead — detect skill gaps from recurring patterns in the current sprint.
 * The beat handler routes matching candidates through cross-sprint transfer.
 */
function checkSkillGaps(ctx: AgentBeatContext): CheckResult {
  const gapCount = ctx.sprintSkillGapCount ?? 0;
  if (gapCount === 0) {
    return { status: "ok", detail: "No skill gaps in current sprint" };
  }
  return {
    status: "action_needed",
    detail: `${gapCount} skill gap(s) in current sprint`,
    suggestedAction: "skills_lead:fill_skill_gap",
  };
}

// ── Role checklist definitions ─────────────────────────────

type CheckFn = (ctx: AgentBeatContext) => CheckResult;

const ROLE_CHECKLISTS: Record<AgentIdentity["role"], CheckFn[]> = {
  ceo: [checkMeetingContribution, checkPendingApprovals, checkBudgetHealth, checkSprintHealth, checkRoadmap, checkBoardMessages],
  cto: [checkMeetingContribution, checkEscalationPending, checkReviewQueue, checkBuildStatus, checkDevProgress, checkAssignedTasks],
  pm: [checkMeetingContribution, checkScopeControl, checkSprintHealth, checkAssignedTasks],
  developer: [checkMeetingContribution, checkAssignedTasks, checkDependenciesMet, checkBuildStatus],
  tester: [checkMeetingContribution, checkReviewPhaseActive, checkBugFixesReady, checkTestQueue, checkAssignedTasks],
  ui_designer: [checkMeetingContribution, checkDesignQueue, checkAssignedTasks],
  marketing: [checkMeetingContribution, checkContentQueue, checkAssignedTasks],
  skills_lead: [
    checkMeetingContribution,
    // Phase 6 proactive checks first — fire even with no assigned task
    checkSkillHealth,
    checkSkillGaps,
    checkUnusedSkills,
    // Reactive task-based checks after
    checkSkillQueue,
    checkAssignedTasks,
  ],
};

// ── Public API ─────────────────────────────────────────────

export interface ChecklistResult {
  results: CheckResult[];
  hasActionNeeded: boolean;
  hasBlocked: boolean;
  /** The first action_needed result, if any. Useful for selecting the next task. */
  primaryAction: CheckResult | null;
}

/**
 * Run the role-specific checklist for an agent's beat context.
 * Returns aggregated results.
 */
export function runChecklist(ctx: AgentBeatContext): ChecklistResult {
  const checks = ROLE_CHECKLISTS[ctx.role] ?? [checkAssignedTasks];
  const results = checks.map((check) => check(ctx));

  const hasActionNeeded = results.some((r) => r.status === "action_needed");
  const hasBlocked = results.some((r) => r.status === "blocked");
  const primaryAction = results.find((r) => r.status === "action_needed") ?? null;

  return { results, hasActionNeeded, hasBlocked, primaryAction };
}
