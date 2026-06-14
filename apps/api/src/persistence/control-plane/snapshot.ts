/**
 * Control plane — read path + version state.
 * Spec 11 / Spec 31 Phase 7.C.d-cp / Spec 34 v3 PR 11.
 *
 * Owns:
 *   - snapshotVersion / mutationCount / startedAt module-level counters
 *   - bumpVersion / noteOneMutation internal helpers (used by `./write.ts`)
 *   - cpLoadSnapshot, cpGetVersion, cpGetSnapshotVersion, cpGetStatus,
 *     cpGetSnapshotSummary — full + lightweight snapshot reads
 *   - cpLoadAgentContext — the per-beat AgentBeatContext assembler
 *
 * Pulls trust scores from `./trust-loader.js` and the latest build-check
 * from `./build-check.js` so cpLoadAgentContext stays a pure assembler
 * without owning either store.
 */
import type {
  AgentBeatContext,
  BeatRecord,
  CompanySnapshot,
  SnapshotVersion,
} from "@arceus/contracts";
import { buildSnapshotView } from "../../orchestration/snapshot-view.js";
import { emitEmployeeActivity } from "../../observability/activity.js";
import { ROLE_CAPABILITIES } from "@arceus/company-runtime";
import {
  getSkillHealth,
  getUnusedSkills,
  analyzeSprintPatterns,
} from "@arceus/company-runtime";
import { getCachedTrustScore } from "./trust-loader.js";
import { getLastBuildCheck, refreshBuildCheckIfStale } from "./build-check.js";

// ── Version + mutation counters ───────────────────────────

let snapshotVersion = 0;
let mutationCount = 0;
const startedAt = new Date().toISOString();

/** Increment + return the new snapshot version. Called by `./write.ts` after a mutation batch. */
export function bumpVersion(): number {
  return ++snapshotVersion;
}

/** Increment the per-mutation counter. Called by `./write.ts` once per applied mutation. */
export function noteOneMutation(): void {
  mutationCount++;
}

// ── Read path ─────────────────────────────────────────────

/**
 * Load the full snapshot. Spec 31 Phase 7.C.d-cp — assembled from
 * canonical via `buildSnapshotView`; returns the empty-snapshot shape
 * (with companyId stamped in) when no company is bootstrapped.
 */
export async function cpLoadSnapshot(companyId: string | null): Promise<CompanySnapshot & { _version: number }> {
  if (!companyId) {
    const { createEmptyCompanySnapshot } = await import("@arceus/company-runtime");
    return { ...createEmptyCompanySnapshot(), _version: snapshotVersion };
  }
  const view = await buildSnapshotView(companyId);
  return { ...view, _version: snapshotVersion };
}

/** Get the current version info. */
export async function cpGetVersion(companyId: string | null): Promise<SnapshotVersion> {
  return {
    companyId,
    version: snapshotVersion,
    updatedAt: new Date().toISOString(),
    mutationCount,
  };
}

/** Get the current snapshot version (for optimistic concurrency). */
export function cpGetSnapshotVersion(): number {
  return snapshotVersion;
}

// ── Status / health ───────────────────────────────────────

export interface ControlPlaneStatus {
  healthy: boolean;
  version: number;
  mutationCount: number;
  upSince: string;
  /** Null when no company is bootstrapped (control plane is pending). */
  companyId: string | null;
  snapshotStale: boolean;
  components: {
    stateStore: { status: "ok" | "degraded"; inMemory: boolean; dbPersist: boolean; dirty: boolean; mutationsSinceHydrate: number; lastHydratedAt: string | null; lastFlushedAt: string | null };
    auditLedger: { status: "ok" | "degraded" };
    executionSubstrate: { status: "ok" | "idle" | "executing" };
  };
}

/**
 * Get the Control Plane health and component status summary. Spec 31
 * Phase 7.C.d-cp — sync-friendly because no DB read is needed; the
 * canonical-direct architecture has no in-memory cache to report on.
 */
export function cpGetStatus(executionStatus: string, companyId: string | null): ControlPlaneStatus {
  const isPending = companyId === null;

  return {
    healthy: true,
    version: snapshotVersion,
    mutationCount,
    upSince: startedAt,
    companyId,
    snapshotStale: false,
    components: {
      stateStore: {
        status: "ok",
        // Post-7.C.d: canonical is the source of truth, no in-memory cache.
        inMemory: false,
        dbPersist: !isPending,
        dirty: false,
        mutationsSinceHydrate: 0,
        lastHydratedAt: null,
        lastFlushedAt: null,
      },
      auditLedger: {
        status: "ok",
      },
      executionSubstrate: {
        status: executionStatus === "idle" ? "idle" : executionStatus === "stopped" ? "idle" : "executing",
      },
    },
  };
}

/**
 * Snapshot summary for the dashboard (lightweight, no full data).
 * Spec 31 Phase 7.C.d-cp — async; reads via `buildSnapshotView`.
 */
export async function cpGetSnapshotSummary(companyId: string | null) {
  if (!companyId) {
    return {
      version: snapshotVersion,
      companyId: null,
      companyName: null,
      companyStatus: "ideation",
      agentCount: 0,
      activeSessions: 0,
      taskStats: { total: 0, created: 0, inProgress: 0, completed: 0, failed: 0, blocked: 0 },
      sprint: null,
      agents: [],
      memories: { totalUnits: 0, agentSummaries: 0 },
      meetings: 0,
      approvals: { total: 0, pending: 0 },
      artifacts: 0,
      chatMessageCount: 0,
      transitions: 0,
    };
  }
  const snap = await buildSnapshotView(companyId);
  const currentSprint = snap.sprints.find((s) => s.id === snap.company.currentSprintId);

  return {
    version: snapshotVersion,
    companyId: snap.company.id,
    companyName: snap.company.name,
    companyStatus: snap.company.status,
    agentCount: snap.agents.length,
    activeSessions: snap.sessions.filter((s) => s.runtimeStatus === "connected").length,
    taskStats: {
      total: snap.tasks.length,
      created: snap.tasks.filter((t) => t.status === "created").length,
      inProgress: snap.tasks.filter((t) => t.status === "in_progress").length,
      completed: snap.tasks.filter((t) => t.status === "completed").length,
      failed: snap.tasks.filter((t) => t.status === "failed").length,
      blocked: snap.tasks.filter((t) => t.status === "blocked").length,
    },
    sprint: currentSprint
      ? {
          id: currentSprint.id,
          number: currentSprint.number,
          status: currentSprint.status,
          title: currentSprint.title,
          taskCount: snap.tasks.filter((t) => t.sprintId === currentSprint.id).length,
        }
      : null,
    agents: snap.agents.map((a) => ({
      id: a.id,
      role: a.role,
      name: a.name,
      status: a.status,
    })),
    memories: {
      totalUnits: snap.memoryUnits.length,
      agentSummaries: snap.memories.length,
    },
    meetings: snap.meetings.length,
    approvals: {
      total: snap.approvals.length,
      pending: snap.approvals.filter((a) => a.status === "pending").length,
    },
    artifacts: snap.artifacts.length,
    chatMessageCount: snap.chatMessages.length,
    transitions: snap.transitions?.length ?? 0,
  };
}

// ── Beat context assembly ─────────────────────────────────

function getLatestDailySyncBrief(snap: CompanySnapshot) {
  const completed = snap.meetings.filter(
    (m) => m.type === "daily_sync" && m.status === "completed" && m.brief,
  );
  const latest = completed[completed.length - 1];
  return latest?.brief ?? null;
}

/**
 * Build the Skills Lead-specific context extensions (Phase 6).
 * Runs the skill-health scan, the unused-skill scan, and the sprint
 * skill-gap count so the heartbeat checklist can branch without any
 * additional I/O.
 */
function buildSkillsLeadContext(companyId: string, currentSprintId: string | null) {
  const health = getSkillHealth(companyId);
  const unusedRaw = getUnusedSkills(companyId, 30);
  const gaps = currentSprintId ? analyzeSprintPatterns(companyId, currentSprintId, 3) : [];

  return {
    skillHealth: {
      totalSkills: health.totalSkills,
      activeSkills: health.activeSkills,
      averageSuccessRate: health.averageSuccessRate,
      worstPerformers: health.worstPerformers.map((w) => ({
        skillId: w.skillId,
        name: w.name,
        successRate: w.successRate,
      })),
    },
    unusedSkills: unusedRaw.map((s) => ({
      skillId: s.id,
      name: s.name,
      lastUsedAt: s.lastUsedAt,
    })),
    sprintSkillGapCount: gaps.length,
  };
}

/**
 * Assemble the AgentBeatContext for a given agent.
 * This is the "Phase 1 — Wake" data payload.
 *
 * Spec 31 Phase 7.C.d-cp — async; reads from canonical via
 * `buildSnapshotView`. Returns null when no company is bootstrapped or
 * the agent is not on the org chart.
 */
export async function cpLoadAgentContext(
  companyId: string,
  agentId: string,
  beatId: string,
  beatNumber: number,
  trigger: BeatRecord["trigger"],
  config: { beatTokenBudget: number; beatCostCeilingCents: number },
): Promise<AgentBeatContext | null> {
  // Native multi-tenant: companyId comes from the BeatRequest (sourced from the
  // roster entry) and identifies WHICH tenant this beat is firing for. No global
  // singleton fallback — that previously let the scheduler pick agent X from
  // tenant B while the global pointer named tenant A, whose snapshot has no
  // agent X → SKIPPED "Agent X not found" for every cross-tenant beat.
  if (!companyId) return null;
  const snap = await buildSnapshotView(companyId);
  const agent = snap.agents.find((a) => a.id === agentId);
  if (!agent) return null;

  const currentSprint = snap.sprints.find((s) => s.id === snap.company.currentSprintId) ?? null;
  const caps = ROLE_CAPABILITIES[agent.role];
  // Sprint overseers (CEO/PM) get all sprint tasks for completion detection;
  // others get only their own. CEO also sees unattached tasks (sprintId=null)
  // like governance "Plan Sprint N" tasks.
  const agentTasks = caps.seesAllSprintTasks
    ? snap.tasks.filter((t) =>
        t.sprintId === currentSprint?.id ||
        (t.assignedRole === agent.role && !t.sprintId)
      )
    : snap.tasks.filter(
        (t) =>
          t.assignedAgentId === agentId ||
          (t.assignedRole === agent.role && !t.assignedAgentId)
      );

  // During sprint review, verifying roles need visibility into bug_fix tasks tracked in
  // reviewState.bugTaskIds (typically assigned to developer) so checkBugFixesReady
  // can see their actual status instead of treating missing tasks as resolved.
  if (caps.verifiesSprintReviews && currentSprint?.status === "reviewing") {
    const reviewState = currentSprint.reviewState;
    if (reviewState && reviewState.bugTaskIds.length > 0) {
      const existingIds = new Set(agentTasks.map((t) => t.id));
      const bugTasks = snap.tasks.filter(
        (t) => (reviewState.bugTaskIds).includes(t.id) && !existingIds.has(t.id)
      );
      agentTasks.push(...bugTasks);
    }
  }

  // Collect artifact ids referenced by this agent's tasks
  const artifactIds = new Set(agentTasks.flatMap((t) => [...t.artifactIds, ...t.incomingArtifactIds]));
  const artifacts = snap.artifacts.filter((a) => artifactIds.has(a.id));

  // Tool enforcement is now performed by the OpenCode plugin against
  // BeatContext.allowedTools (built in beat-context-builder.ts). The
  // legacy per-company service-registry + trust filter were removed;
  // we keep agentTrustScore for telemetry / RoleCapabilities only.
  const agentTrustScore = getCachedTrustScore(agentId);
  const filteredToolNames: string[] = [];

  // Memory/priming context
  const agentMemory = snap.memories.find((m) => m.agentId === agentId);
  const agentHabits = snap.habits.filter((h) => h.agentId === agentId && h.status === "active");
  const agentPriming = snap.priming.find((p) => p.agentId === agentId);

  // Recent board messages (last 10)
  const recentBoardMessages = snap.chatMessages
    .filter((m) => m.role === "board" || m.role === "ceo")
    .slice(-10);

  // Recent meetings (last 5 completed + any currently collecting)
  const recentMeetings = [
    ...snap.meetings.filter((m) => m.status === "collecting"),
    ...snap.meetings.filter((m) => m.status === "completed").slice(-5),
  ];

  // Pending approvals
  const pendingApprovals = snap.approvals.filter((a) => a.status === "pending");

  // Refresh build check for roles that consume build context (e.g. CTO/developer) if stale (>2 min).
  if (caps.receivesBuildContext) {
    refreshBuildCheckIfStale();
  }
  const lastBuildCheck = getLastBuildCheck();

  emitEmployeeActivity(agent.role, "context", `Beat ${beatId}: context assembled — ${agentTasks.length} tasks, ${artifacts.length} artifacts (trust=${agentTrustScore.toFixed(2)}), ${agentMemory ? agentMemory.currentFocus.length + agentMemory.recentLearnings.length + agentMemory.activePatterns.length : 0} memories, ${agentHabits.length} habits, ${recentMeetings.length} meetings, ${pendingApprovals.length} approvals`, {
    beatId,
    detail: {
      agentId: agent.id,
      agentName: agent.name,
      role: agent.role,
      taskCount: agentTasks.length,
      taskIds: agentTasks.map(t => t.id),
      taskTitles: agentTasks.map(t => `[${t.status}] ${t.title}`),
      artifactCount: artifacts.length,
      memoryCount: agentMemory ? agentMemory.currentFocus.length + agentMemory.recentLearnings.length + agentMemory.activePatterns.length : 0,
      habitCount: agentHabits.length,
      meetingCount: recentMeetings.length,
      approvalCount: pendingApprovals.length,
      buildCheckStatus: lastBuildCheck.status,
      budgetRemainingCents: snap.company.budgetCents - snap.company.spentCents,
    },
  });

  return {
    beatId,
    beatNumber,
    trigger,
    startedAt: new Date().toISOString(),

    agentId: agent.id,
    agentName: agent.name,
    role: agent.role,
    soul: agent.soul,

    company: snap.company,
    currentSprint,

    hierarchy: snap.hierarchy,
    managerAgentId: agent.managerAgentId,
    reportAgentIds: agent.reportAgentIds,

    tasks: agentTasks,
    taskProgress: [], // Phase 2: populated when task_progress mutations exist

    artifacts,

    memories: agentMemory
      ? [
          ...agentMemory.currentFocus,
          ...agentMemory.recentLearnings,
          ...agentMemory.activePatterns,
        ]
      : [],
    habits: agentHabits.map((h) => h.name),
    priming: agentPriming?.lastDisposition ?? "",

    availableTools: filteredToolNames,
    trustFactor: agentTrustScore,

    approvals: pendingApprovals,
    recentBoardMessages,
    recentMeetings,
    latestDailySyncBrief: getLatestDailySyncBrief(snap),

    beatTokenBudget: config.beatTokenBudget,
    beatCostCeilingCents: config.beatCostCeilingCents,
    companyBudgetRemainingCents: snap.company.budgetCents - snap.company.spentCents,
    lastBuildCheck: lastBuildCheck.status !== "unknown" ? lastBuildCheck : undefined,

    // Spec 14 Phase 6 — Skills Lead proactive heartbeat context
    ...(caps.receivesSkillsLeadContext ? buildSkillsLeadContext(snap.company.id, currentSprint?.id ?? null) : {}),
  };
}
