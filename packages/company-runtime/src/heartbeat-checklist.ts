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
import { loadChecklistConfig, type ChecklistConfig } from "./checklist-config";

// ── Config (cluster C17 — F-242 + F-250) ───────────────────
//
// `loadChecklistConfig()` reads ARCEUS_CHECKLIST_* env vars on first call.
// Tests can override via `setChecklistConfigForTests({ ... })`.

const activeConfig: ChecklistConfig = loadChecklistConfig();

// ── Individual check functions ─────────────────────────────

/** Check if the agent has pending approvals to review. */
function checkPendingApprovals(ctx: AgentBeatContext): CheckResult {
  const pending = ctx.approvals.filter((a) => a.status === "pending");
  if (pending.length === 0) return { status: "ok", detail: "No pending approvals" };
  return {
    status: "action_needed",
    detail: `${pending.length} pending approval(s)`,
    suggestedAction: `Review approval: ${pending[0].title}`,
  };
}

/**
 * Check company budget utilization — blocks at 0%, warns above the
 * unhealthy ratio (default 0.9, configurable via
 * `ARCEUS_CHECKLIST_BUDGET_UNHEALTHY_RATIO` — F-250).
 */
function checkBudgetHealth(ctx: AgentBeatContext): CheckResult {
  if (ctx.companyBudgetRemainingCents <= 0) {
    return { status: "blocked", detail: "Budget exhausted", suggestedAction: "Pause work — budget is 0" };
  }
  const usedPct = ((ctx.company.spentCents / ctx.company.budgetCents) * 100).toFixed(1);
  if (ctx.company.spentCents > ctx.company.budgetCents * activeConfig.budgetUnhealthyRatio) {
    return { status: "action_needed", detail: `Budget at ${usedPct}%`, suggestedAction: "Review spending" };
  }
  return { status: "ok", detail: `Budget at ${usedPct}%` };
}

/**
 * Check for a blocked task that THIS agent owns and that doesn't yet have
 * an open "Fix blocker" follow-up. Role-targeted so only the responsible
 * agent gets woken (no more CEO/PM looping with no-handler messages).
 *
 * Idempotency: if a follow-up task titled `Fix blocker for <id>` already
 * exists in a handling state, the original blocker is considered
 * dealt with and we return ok — preventing per-beat re-fires.
 */
function checkSprintHealth(ctx: AgentBeatContext): CheckResult {
  if (!ctx.currentSprint) {
    return { status: "ok", detail: "No active sprint" };
  }
  // A follow-up counts as handling its blocker unless it cancelled or
  // failed. Completed follow-ups suppress too: completion either
  // reopened the original (no longer blocked) or formally abandoned it
  // with a written rationale — re-spawning would churn duplicates now
  // that blocked tasks wake their owner role every interval.
  const isHandling = (s: string) => !["cancelled", "failed"].includes(s);
  // One level of follow-up only: a blocked "Fix blocker for X" task must
  // NOT spawn "Fix blocker for (Fix blocker for X)" — observed live, the
  // chain recurses unboundedly while the underlying cause persists. A
  // blocked fix-blocker stays re-claimable by the role (wake-on-blocked
  // keeps the role beating); recovery is re-claim or human/CTO triage.
  const myBlockers = ctx.tasks.filter(
    (t) =>
      (t.status === "blocked" || t.status === "failed") &&
      t.assignedRole === ctx.role &&
      !t.title.startsWith("Fix blocker for "),
  );
  if (myBlockers.length === 0) {
    return { status: "ok", detail: "No blocked tasks owned by me" };
  }
  // Skip blockers that already have a handling follow-up
  const pending = myBlockers.filter((t) => {
    const followupTitle = `Fix blocker for ${t.id}`;
    const hasHandlingFollowup = ctx.tasks.some(
      (f) => f.title === followupTitle && isHandling(f.status),
    );
    return !hasHandlingFollowup;
  });
  if (pending.length === 0) {
    return { status: "ok", detail: `${myBlockers.length} blocker(s) already being worked on` };
  }
  const next = pending[0];
  // Audit C11: typed dispatch instead of colon-string (was: `task_resolve_blocker:${next.id}`)
  return {
    status: "action_needed",
    detail: `Task "${next.title}" (${next.id}) is ${next.status}`,
    suggestedAction: `Resolve blocker on task: ${next.title}`,
    dispatch: { kind: "task_resolve_blocker", taskId: next.id },
  };
}

/** CEO proactive check: propose next sprint when current is done or absent. */
function checkRoadmap(ctx: AgentBeatContext): CheckResult {
  // CEO proactive: if sprint is complete or no sprint, propose next
  if (!ctx.currentSprint) {
    return {
      status: "action_needed",
      detail: "No active sprint",
      suggestedAction: "Call sprint_create with a goal and tasks to start the next sprint.",
    };
  }
  if (ctx.currentSprint.status === "reviewing") {
    return {
      status: "action_needed",
      detail: `Sprint ${ctx.currentSprint.number} is in review`,
      suggestedAction: `Call sprint_finalize for sprint ${ctx.currentSprint.id} to complete the sprint, then sprint_create for the next sprint.`,
    };
  }
  if (ctx.currentSprint.status === "completed") {
    return {
      status: "action_needed",
      detail: `Sprint ${ctx.currentSprint.number} is completed`,
      suggestedAction: "Immediately call sprint_create with a goal and tasks for the next sprint, scoped from this sprint's outcome. Do NOT emit an approval card or wait for board sign-off — chain autonomously.",
    };
  }
  // Detect all tasks terminal even if sprint status hasn't been updated yet
  const sprintTasks = ctx.tasks.filter((t) => t.sprintId === ctx.currentSprint!.id);
  if (sprintTasks.length > 0 && sprintTasks.every((t) => ["completed", "failed", "cancelled", "blocked"].includes(t.status))) {
    return {
      status: "action_needed",
      detail: `All ${sprintTasks.length} tasks in sprint ${ctx.currentSprint.number} are terminal`,
      suggestedAction: `All tasks are done. Call sprint_finalize for sprint ${ctx.currentSprint.id}, then immediately sprint_create the next sprint scoped from this sprint's outcome. Do NOT emit an approval card or wait for the board — chain autonomously.`,
    };
  }
  return { status: "ok", detail: "Sprint in progress" };
}

/** CTO check: detect tasks in "verifying" status awaiting code review. */
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

/** Check build status — flags build errors as actionable (skipped during sprint review). */
function checkBuildStatus(ctx: AgentBeatContext): CheckResult {
  // During sprint review the tester drives verification — build errors surface
  // there rather than blocking developer/CTO beats with a no-handler action.
  if (ctx.currentSprint?.status === "reviewing") {
    return { status: "ok", detail: "Sprint in review — build health checked by tester verification" };
  }
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

/** CTO check: flag developer tasks that appear stale (no progress for >10min). */
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

/** Find the highest-priority actionable task assigned to this specific agent. */
function checkAssignedTasks(ctx: AgentBeatContext): CheckResult {
  // CEO/PM receive ALL sprint tasks in ctx.tasks (for sprint-completion visibility
  // in control-plane.ts), but their checklist should only drive THEIR OWN work —
  // otherwise PM ends up "working on" CEO-assigned tasks every beat, burning tokens
  // without ever transitioning state. Filter down to tasks actually owned by this
  // agent before deciding on the next action.
  const mine = ctx.tasks.filter(
    (t) =>
      t.assignedAgentId === ctx.agentId ||
      (t.assignedRole === ctx.role && !t.assignedAgentId)
  );
  const actionable = mine.filter(
    (t) => t.status === "planned" || t.status === "created" || t.status === "in_progress"
  );
  if (actionable.length === 0) {
    return { status: "ok", detail: "No actionable tasks assigned to me" };
  }
  // Prioritize: in_progress first, then planned, then created
  const next =
    actionable.find((t) => t.status === "in_progress") ??
    actionable.find((t) => t.status === "planned") ??
    actionable[0];
  return {
    status: "action_needed",
    detail: `${actionable.length} actionable task(s) assigned to me`,
    suggestedAction: `Work on: ${next.title} (${next.status})`,
  };
}

/** Check if any of the agent's tasks have unresolved upstream dependencies. */
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

/** CEO check: detect unanswered board messages requiring a response. */
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

/** PM check: detect tasks not assigned to any sprint (scope creep). */
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

/** Tester check: find tasks in "verifying" status assigned to the tester role. */
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
  if (sprint?.status !== "reviewing") return { status: "ok", detail: "Sprint not in review" };

  const reviewState = sprint.reviewState;
  if (!reviewState) return { status: "ok", detail: "No review state" };

  if (reviewState.phase === "tester_verification") {
    return {
      status: "action_needed",
      detail: `Sprint ${sprint.number} awaiting tester verification (cycle ${reviewState.reworkCycleCount})`,
      suggestedAction: `Run tester verification for Sprint ${sprint.number}`,
      dispatch: { kind: "sprint_review.run_tester_verification" },
    };
  }

  if (reviewState.phase === "final_gate") {
    return {
      status: "action_needed",
      detail: `Sprint ${sprint.number} awaiting final gate`,
      suggestedAction: `Run final gate for Sprint ${sprint.number}`,
      dispatch: { kind: "sprint_review.run_final_gate" },
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
  if (sprint?.status !== "reviewing") return { status: "ok", detail: "Sprint not in review" };

  const reviewState = sprint.reviewState;
  if (reviewState?.phase !== "rework") return { status: "ok", detail: "Not in rework phase" };

  const bugTaskIds: string[] = reviewState.bugTaskIds ?? [];
  if (bugTaskIds.length === 0) {
    // Defensive: if we're in rework with no bug tasks tracked (e.g. a tester
    // parse-failure path advanced phase to rework without creating bugs),
    // don't wedge the sprint — re-verify on the next beat. The only other
    // check that looks at rework is checkEscalationPending, which only fires
    // when escalatedToCto === true, so without this branch the sprint is
    // permanently stuck.
    return {
      status: "action_needed",
      detail: `Sprint ${sprint.number} in rework with no bug tasks — re-verifying`,
      suggestedAction: `Re-test Sprint ${sprint.number} after rework`,
      dispatch: { kind: "sprint_review.retest_after_rework" },
    };
  }

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
      suggestedAction: `Re-test Sprint ${sprint.number} (${bugTaskIds.length} bug fix(es) ready)`,
      dispatch: { kind: "sprint_review.retest_after_rework" },
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
 *
 * Fires `sprint_review:cto_escalation_review` for a fresh escalation,
 * or `sprint_review:cto_escalation_force_complete` if the escalation
 * has been pending longer than `escalationTimeoutMs` (F-242). Once the
 * CTO decides "fix" and the sprint is stuck in tester_verification /
 * rework past `stuckAfterFixTimeoutMs`, force-complete as a safety valve.
 *
 * Both timeouts come from `ChecklistConfig` so deployments can tune them
 * (defaults: 5min escalation, 10min stuck-after-fix) and tests can
 * shorten them via `setChecklistConfigForTests`.
 */
function checkEscalationPending(ctx: AgentBeatContext): CheckResult {
  const sprint = ctx.currentSprint;
  if (sprint?.status !== "reviewing") return { status: "ok", detail: "Sprint not in review" };

  const reviewState = sprint.reviewState;
  if (!reviewState) return { status: "ok", detail: "No review state" };

  if (reviewState.escalatedToCto && reviewState.ctoDecision === null) {
    // Safety valve — if escalation has been pending for too long without a
    // decision, force-complete rather than looping the CTO indefinitely.
    const escalatedAtMs = reviewState.escalatedAt ? new Date(reviewState.escalatedAt).getTime() : null;
    if (escalatedAtMs !== null && Date.now() - escalatedAtMs > activeConfig.escalationTimeoutMs) {
      const ageMinutes = Math.round((Date.now() - escalatedAtMs) / 60_000);
      return {
        status: "action_needed",
        detail: `Sprint ${sprint.number} escalation pending ${ageMinutes}m without decision — force-completing as safety valve`,
        suggestedAction: `Force-complete Sprint ${sprint.number} (escalation timeout)`,
        dispatch: { kind: "sprint_review.cto_escalation_force_complete" },
      };
    }
    return {
      status: "action_needed",
      detail: `Sprint ${sprint.number} escalated after ${reviewState.reworkCycleCount} rework cycles — awaiting CTO decision (fix/skip/abort)`,
      suggestedAction: `Review CTO escalation for Sprint ${sprint.number}`,
      dispatch: { kind: "sprint_review.cto_escalation_review" },
    };
  }

  // Extended safety valve: CTO already decided "fix" but the sprint
  // is still stuck in tester_verification or rework past a generous timeout
  // (`stuckAfterFixTimeoutMs`, default 2× `escalationTimeoutMs`). This
  // happens when the developer beat has no dispatchable handler for build
  // errors during review, or the rework cycle fails to advance.
  if (
    reviewState.escalatedToCto &&
    reviewState.ctoDecision === "fix" &&
    ["tester_verification", "rework"].includes(reviewState.phase)
  ) {
    const escalatedAtMs = reviewState.escalatedAt ? new Date(reviewState.escalatedAt).getTime() : null;
    if (escalatedAtMs !== null && Date.now() - escalatedAtMs > activeConfig.stuckAfterFixTimeoutMs) {
      const ageMinutes = Math.round((Date.now() - escalatedAtMs) / 60_000);
      return {
        status: "action_needed",
        detail: `Sprint ${sprint.number} stuck in ${reviewState.phase} for ${ageMinutes}m after CTO "fix" decision — force-completing`,
        suggestedAction: `Force-complete stuck Sprint ${sprint.number}`,
        dispatch: { kind: "sprint_review.cto_escalation_force_complete" },
      };
    }
  }

  return { status: "ok", detail: "No pending escalation" };
}

/** UI Designer check: find actionable design tasks. */
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

/** Marketing check: find actionable content/campaign tasks. */
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

/** Skills Lead check: find actionable skill authoring/curation tasks. */
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
    suggestedAction: `Contribute to meeting: ${collectingMeeting.title}`,
    dispatch: { kind: "meeting_contribution", meetingId: collectingMeeting.id },
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
    suggestedAction: `Mutate underperforming skill: ${worst.name}`,
    dispatch: { kind: "skills_lead.mutate_underperformer" },
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
    suggestedAction: `Deprecate ${unused.length} stale skill(s)`,
    dispatch: { kind: "skills_lead.deprecate_unused" },
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
    suggestedAction: `Fill ${gapCount} skill gap(s) in current sprint`,
    dispatch: { kind: "skills_lead.fill_skill_gap" },
  };
}

// ── Role checklist definitions ─────────────────────────────

type CheckFn = (ctx: AgentBeatContext) => CheckResult;

const ROLE_CHECKLISTS: Record<AgentIdentity["role"], CheckFn[]> = {
  // checkSprintHealth is role-targeted (a role repairs only its OWN
  // blocked/failed tasks), so EVERY role that can own tasks must run
  // it — a role missing it can never spawn the "Fix blocker" follow-up
  // for its own blockers, and a company whose remaining work hangs off
  // that blocker deadlocks. Observed live: tester blocked the QA task
  // and its checklist (which lacked the check) idled forever.
  //
  // CEO is otherwise woken only on real strategic triggers: pending
  // approvals, roadmap (no/done sprint), or active meetings.
  ceo: [checkMeetingContribution, checkPendingApprovals, checkSprintHealth, checkRoadmap],
  cto: [checkEscalationPending, checkMeetingContribution, checkReviewQueue, checkSprintHealth, checkBuildStatus, checkDevProgress, checkAssignedTasks],
  pm: [checkMeetingContribution, checkScopeControl, checkSprintHealth, checkAssignedTasks],
  developer: [checkMeetingContribution, checkSprintHealth, checkAssignedTasks, checkDependenciesMet, checkBuildStatus],
  // Tester only fires at sprint-end now. Per-task verifying is handled by
  // the developer's self-test (bash + task_complete with evidence). The
  // legacy checkTestQueue would have routed verifying-status tasks here;
  // that path is intentionally retired.
  tester: [checkMeetingContribution, checkReviewPhaseActive, checkSprintHealth, checkBugFixesReady, checkAssignedTasks],
  ui_designer: [checkMeetingContribution, checkSprintHealth, checkDesignQueue, checkAssignedTasks],
  marketing: [checkMeetingContribution, checkSprintHealth, checkContentQueue, checkAssignedTasks],
  skills_lead: [
    checkMeetingContribution,
    // Phase 6 proactive checks first — fire even with no assigned task
    checkSkillHealth,
    checkSkillGaps,
    checkUnusedSkills,
    checkSprintHealth,
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
