/**
 * Control Plane Facade — Spec 11 Phase 2 + Phase 4
 *
 * Wraps existing company-state.ts / store.ts into the Control Plane
 * interface. All state reads go through loadSnapshot(), all writes
 * through applyMutations(). The audit ledger records every mutation.
 *
 * Phase 4: store.ts is now a read-cache with explicit lifecycle
 * (hydrate/flush/teardown). The CP reports cache staleness and
 * handles all mutation types including agent_status/company_status.
 */

import { readFileSync } from "node:fs";
import type {
  CompanySnapshot,
  EventEnvelope,
  StateMutation,
  SnapshotVersion,
  AgentBeatContext,
  BeatRecord,
  TaskProgress,
  TaskResult,
} from "@arceus/contracts";
import { getActiveCompanyId } from "./active-company.js";
import { buildSnapshotView } from "../orchestration/snapshot-view.js";
import * as tasksRepo from "@arceus/db/src/repos/tasks.js";
import { audit, auditSystem } from "../observability/audit-ledger.js";
import { emitEmployeeActivity } from "../observability/activity.js";
import { isDatabaseConfigured, getDb } from "@arceus/db";
import { heartbeatRuns, trustScoresTable, policyViolations as policyViolationsCanonical } from "@arceus/db";
import * as companiesRepo from "@arceus/db/src/repos/companies.js";
import * as agentsRepo from "@arceus/db/src/repos/agents.js";
import { friendlyToUuid } from "@arceus/db/src/repos/_uuid.js";
import { desc, eq, and, sql } from "drizzle-orm";
import {
  createInitialTrust,
  adjustTrust,
  buildTrustEvent,
  getTrustTier,
  TRUST_CONFIG,
  ROLE_CAPABILITIES,
} from "@arceus/company-runtime";
import type { TrustScore, TrustEvent, PolicyViolation } from "@arceus/contracts";
import {
  getSkillHealth,
  getUnusedSkills,
  analyzeSprintPatterns,
} from "@arceus/company-runtime";
import {
  upsertTask,
  updateTask,
  upsertSprint,
  updateSprint,
  upsertMeeting,
  upsertApproval,
  updateApproval,
  appendChatMessage,
  updateAgentStatus,
  updateCompanyStatus,
  updateTaskProgress,
} from "./mutations/index.js";

// ── Version tracking ───────────────────────────────────────

let snapshotVersion = 0;
let buildCheckProductDir: string | null = null;

/** Set the product directory for build status checks. */
export function cpSetBuildCheckDir(dir: string) {
  buildCheckProductDir = dir;
}
let mutationCount = 0;
const startedAt = new Date().toISOString();

function bumpVersion(): number {
  return ++snapshotVersion;
}

// ── Read path ──────────────────────────────────────────────

/**
 * Load the full snapshot. Spec 31 Phase 7.C.d-cp — assembled from
 * canonical via `buildSnapshotView`; returns the empty-snapshot shape
 * (with companyId stamped in) when no company is bootstrapped.
 */
export async function cpLoadSnapshot(): Promise<CompanySnapshot & { _version: number }> {
  const companyId = getActiveCompanyId();
  if (!companyId) {
    const { createEmptyCompanySnapshot } = await import("@arceus/company-runtime");
    return { ...createEmptyCompanySnapshot(), _version: snapshotVersion };
  }
  const view = await buildSnapshotView(companyId);
  return { ...view, _version: snapshotVersion };
}

/**
 * Cold-start hydration. The legacy `company_states` JSON blob is being
 * dropped in 7.C.d's legacy-tables migration; this path is now a no-op
 * because canonical is the durable source of truth.
 */
export async function cpLoadPersistedSnapshot(_companyId?: string): Promise<null> {
  return null;
}

/** Get the current version info. */
export async function cpGetVersion(): Promise<SnapshotVersion> {
  const companyId = getActiveCompanyId() ?? "";
  return {
    companyId,
    version: snapshotVersion,
    updatedAt: new Date().toISOString(),
    mutationCount,
  };
}

/**
 * Called by store.ts on every replaceState().
 * Bumps the version counter so the CP tracks all mutations.
 */
export function cpNotifyStateChange() {
  bumpVersion();
  mutationCount++;
}

// ── Write path ─────────────────────────────────────────────

/**
 * Apply a batch of mutations atomically.
 *
 * Spec 31 Phase 7.C.d-cp — async; mutators write straight to canonical
 * via `mutations.ts`. The optimistic-concurrency check is still
 * disabled (B.4 finding: every concurrent heartbeat raced against
 * itself), so `expectedVersion` is informational only.
 */
export async function cpApplyMutations(
  companyId: string,
  mutations: StateMutation[],
  causation?: { eventId?: string; summary?: string },
  expectedVersion?: number
): Promise<{ version: number; applied: number; errors: string[] }> {
  // Optimistic concurrency check — disabled: with concurrent heartbeats the
  // version races ahead and every agent's mutations get discarded.
  // if (expectedVersion !== undefined && expectedVersion !== snapshotVersion) {
  //   return {
  //     version: snapshotVersion,
  //     applied: 0,
  //     errors: [`Optimistic concurrency conflict: expected v${expectedVersion}, current v${snapshotVersion}`],
  //   };
  // }

  const errors: string[] = [];
  let applied = 0;

  for (const mutation of mutations) {
    try {
      await applyOneMutation(companyId, mutation, causation?.eventId);
      applied++;
      mutationCount++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${mutation.type}: ${msg}`);
      audit({
        companyId,
        category: "error",
        severity: "error",
        eventType: "mutation_failed",
        summary: `Mutation ${mutation.type} failed: ${msg}`,
        detail: { mutation, error: msg },
        causationId: causation?.eventId,
      });
    }
  }

  const version = bumpVersion();

  if (applied > 0) {
    audit({
      companyId,
      category: "system",
      severity: "debug",
      eventType: "mutations_applied",
      summary: `${applied} mutation(s) applied → v${version}${errors.length ? ` (${errors.length} failed)` : ""}`,
      detail: {
        version,
        applied,
        errors: errors.length > 0 ? errors : undefined,
        types: mutations.map((m) => m.type),
      },
      causationId: causation?.eventId,
    });
  }

  return { version, applied, errors };
}

async function applyOneMutation(companyId: string, mutation: StateMutation, _causationId?: string): Promise<void> {
  switch (mutation.type) {
    case "task_status":
      await updateTask(mutation.taskId, (t) => ({
        ...t,
        status: mutation.status,
        ...(mutation.summary ? { summary: mutation.summary } : {}),
      }));
      break;

    case "task_assign":
      await updateTask(mutation.taskId, (t) => ({
        ...t,
        assignedTo: mutation.agentId,
      }));
      break;

    case "task_create":
      await upsertTask(mutation.task);
      break;

    case "sprint_status":
      await updateSprint(mutation.sprintId, (s) => ({
        ...s,
        status: mutation.status,
      }));
      break;

    case "sprint_create":
      await upsertSprint(mutation.sprint);
      break;

    case "meeting_record":
      await upsertMeeting(mutation.meeting);
      break;

    case "approval_create":
      await upsertApproval(mutation.approval);
      break;

    case "approval_resolve":
      await updateApproval(mutation.approvalId, (a) => ({
        ...a,
        status: mutation.status,
      }));
      break;

    case "chat_message":
      await appendChatMessage(mutation.message);
      break;

    case "transition_append":
      // Spec 31 Phase 7.B.4 — transitions/feedback retired with the snapshot.
      // No-op: orchestration/state.ts owns the in-memory log if needed.
      break;

    case "transition_update":
      // No-op: see transition_append above.
      break;

    case "agent_status":
      await updateAgentStatus(mutation.agentId, mutation.status);
      break;

    case "company_status":
      // Spec 31 Phase 7.C.d — updateCompanyStatus is keyed by companyId now.
      await updateCompanyStatus(companyId, mutation.status);
      break;

    case "task_progress":
      updateTaskProgress(mutation.taskId, mutation.progress);
      break;

    default:
      // Exhaustiveness: TS compile-error if a new variant is added to the
      // union without a case here. `_exhaustive` will be `never` only when
      // every variant above is handled.
      const _exhaustive: never = mutation;
      throw new Error(`Unknown mutation type: ${JSON.stringify(_exhaustive)}`);
  }
}

// ── Control Plane status / health ──────────────────────────

export interface ControlPlaneStatus {
  healthy: boolean;
  version: number;
  mutationCount: number;
  upSince: string;
  companyId: string;
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
export function cpGetStatus(executionStatus: string): ControlPlaneStatus {
  const companyId = getActiveCompanyId() ?? "";
  const isPending = !companyId;

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
export async function cpGetSnapshotSummary() {
  const companyId = getActiveCompanyId();
  if (!companyId) {
    return {
      version: snapshotVersion,
      companyId: "",
      companyName: "",
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

// ── Meeting context helpers ────────────────────────────────

function getLatestDailySyncBrief(snap: CompanySnapshot) {
  const completed = snap.meetings.filter(
    (m) => m.type === "daily_sync" && m.status === "completed" && m.brief,
  );
  const latest = completed[completed.length - 1];
  return latest?.brief ?? null;
}

// ── Heartbeat / Beat lifecycle (Spec 12 Phase 2) ──────────

/**
 * Assemble the AgentBeatContext for a given agent.
 * This is the "Phase 1 — Wake" data payload.
 *
 * Spec 31 Phase 7.C.d-cp — async; reads from canonical via
 * `buildSnapshotView`. Returns null when no company is bootstrapped or
 * the agent is not on the org chart.
 */
export async function cpLoadAgentContext(
  agentId: string,
  beatId: string,
  beatNumber: number,
  trigger: BeatRecord["trigger"],
  config: { beatTokenBudget: number; beatCostCeilingCents: number }
): Promise<AgentBeatContext | null> {
  const companyId = getActiveCompanyId();
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
  const agentTrustScore = trustScoreCache.get(agentId)?.score ?? TRUST_CONFIG.initialScore;
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

  // Refresh build check for roles that consume build context (e.g. CTO/developer) if stale (>2 min)
  if (caps.receivesBuildContext && buildCheckProductDir) {
    const staleMs = Date.now() - new Date(lastBuildCheck.checkedAt).getTime();
    if (staleMs > 120_000 || lastBuildCheck.status === "unknown") {
      cpRunBuildCheck(buildCheckProductDir);
    }
  }

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
 * Load the active sprint from canonical (convenience).
 * Spec 31 Phase 7.C.d-cp — async; returns null when no active company.
 */
export async function cpLoadActiveSprint() {
  const companyId = getActiveCompanyId();
  if (!companyId) return null;
  const snap = await buildSnapshotView(companyId);
  return snap.sprints.find((s) => s.id === snap.company.currentSprintId) ?? null;
}

// ── Beat record persistence — Spec 31 Phase 7.B.5.1 ────────
//
// The legacy `beat_records` text-PK table has been retired. Beat
// history is now persisted to the canonical `heartbeat_runs` (uuid PK,
// FK to companies/agents). The legacy `BeatRecord` contract carries
// fields the canonical schema doesn't (phases, snapshotVersion*,
// outcome enum, summary, errorMessage) — those round-trip through the
// `triggerDetail` jsonb column, keyed under `_legacy.*` so the column's
// primary purpose (carrying the structured trigger payload) stays clear.
//
// Status mapping at write time:
//   running   → running
//   completed → completed
//   failed    → failed
//   timed_out → failed (cause stamped from errorMessage or "timed_out")
//   skipped   → never reaches commit (the heartbeat engine returns
//                null before the post-beat persistence hook fires)

interface LegacyBeatSidecar {
  /** Original friendly ids — used to round-trip back to BeatRecord shape. */
  friendlyIds?: { id: string; companyId: string; agentId: string | null };
  /** Original BeatTrigger object (interval | event). */
  trigger?: BeatRecord["trigger"];
  phases?: BeatRecord["phases"];
  snapshotVersionRead?: number | null;
  snapshotVersionWritten?: number | null;
  outcome?: BeatRecord["outcome"];
  summary?: string | null;
  errorMessage?: string | null;
}

function legacyStatusToCanonical(s: BeatRecord["status"]): "running" | "completed" | "failed" {
  if (s === "running") return "running";
  if (s === "completed") return "completed";
  // failed / timed_out / skipped all collapse to "failed" on the
  // canonical side; sidecar carries the precise legacy status.
  return "failed";
}

/**
 * Commit a BeatRecord to canonical `heartbeat_runs`. Non-blocking — logs
 * a warning on failure. Returns true if committed successfully.
 *
 * Friendly ids (`beat_…`, `agent_…`, `company_…`) are mapped to their
 * deterministic uuid form via `friendlyToUuid` so the FK references
 * land on the canonical rows. Legacy-only fields are stashed in
 * `triggerDetail._legacy` for read-side reconstruction.
 */
export async function cpCommitBeatRecord(record: BeatRecord): Promise<boolean> {
  if (!isDatabaseConfigured()) {
    return false;
  }
  // heartbeat_runs.agent_id is NOT NULL — legacy contract allowed it
  // because some pre-Spec-12 records were system-scoped. Skip those
  // rather than insert with a bogus agent uuid.
  if (!record.agentId) {
    return false;
  }

  try {
    const db = getDb();
    const sidecar: LegacyBeatSidecar = {
      friendlyIds: {
        id: record.id,
        companyId: record.companyId,
        agentId: record.agentId,
      },
      trigger: record.trigger,
      phases: record.phases,
      snapshotVersionRead: record.snapshotVersionRead,
      snapshotVersionWritten: record.snapshotVersionWritten,
      outcome: record.outcome,
      summary: record.summary,
      errorMessage: record.errorMessage,
    };
    const cause =
      record.errorMessage ??
      (record.status === "timed_out" ? "timed_out" : record.status === "skipped" ? "skipped" : null);
    await db
      .insert(heartbeatRuns)
      .values({
        id: friendlyToUuid(record.id),
        companyId: companiesRepo.toDbId(record.companyId),
        agentId: agentsRepo.toDbId(record.agentId),
        beatNumber: record.beatNumber,
        trigger: record.trigger.type, // "interval" | "event"
        triggerDetail: { _legacy: sidecar },
        status: legacyStatusToCanonical(record.status),
        cause,
        startedAt: new Date(record.startedAt),
        finishedAt: record.endedAt ? new Date(record.endedAt) : null,
        totalTokens: record.totalTokens,
        totalCostCents: Math.round(record.costCents),
        toolCallCount: record.phases?.execution?.toolCalls ?? 0,
      })
      .onConflictDoUpdate({
        target: heartbeatRuns.id,
        set: {
          status: legacyStatusToCanonical(record.status),
          cause,
          finishedAt: record.endedAt ? new Date(record.endedAt) : null,
          totalTokens: record.totalTokens,
          totalCostCents: Math.round(record.costCents),
          toolCallCount: record.phases?.execution?.toolCalls ?? 0,
          triggerDetail: { _legacy: sidecar },
        },
      });
    return true;
  } catch (err) {
    console.warn("[CP] Failed to commit beat record:", err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * Retrieve beat history from canonical `heartbeat_runs`. Falls back to
 * empty array if DB is unavailable. The legacy `BeatRecord` shape is
 * reconstructed from the canonical row; legacy-only fields come from
 * the `triggerDetail._legacy` sidecar (see `cpCommitBeatRecord`).
 */
export async function cpGetBeatHistory(
  companyId: string,
  opts?: { limit?: number; agentId?: string },
): Promise<BeatRecord[]> {
  if (!isDatabaseConfigured()) return [];

  try {
    const db = getDb();
    const limit = opts?.limit ?? 100;
    const conditions = [eq(heartbeatRuns.companyId, companiesRepo.toDbId(companyId))];
    if (opts?.agentId) conditions.push(eq(heartbeatRuns.agentId, agentsRepo.toDbId(opts.agentId)));

    const rows = await db
      .select()
      .from(heartbeatRuns)
      .where(conditions.length === 1 ? conditions[0] : and(...conditions))
      .orderBy(desc(heartbeatRuns.startedAt))
      .limit(limit);

    return rows.map((r): BeatRecord => {
      const sidecar = ((r.triggerDetail as { _legacy?: LegacyBeatSidecar } | null)?._legacy) ?? {};
      // Reconstruct trigger: prefer sidecar (full BeatTrigger object);
      // fall back to a minimal interval shape if the legacy payload was
      // never written (mixed-source rows).
      const trigger: BeatRecord["trigger"] =
        sidecar.trigger ??
        (r.trigger === "event"
          ? { type: "event", event: "task_assigned" }
          : { type: "interval", scheduledAt: r.startedAt?.toISOString() ?? new Date().toISOString() });
      // Map canonical → legacy status. 'stranded' surfaces as 'failed'
      // for legacy contract consumers; the sidecar carries the original
      // status when the row was written via this module.
      const legacyStatus: BeatRecord["status"] =
        r.status === "running"
          ? "running"
          : r.status === "completed"
            ? "completed"
            : r.status === "stranded"
              ? "failed"
              : "failed";
      return {
        id: sidecar.friendlyIds?.id ?? r.id,
        companyId: sidecar.friendlyIds?.companyId ?? r.companyId,
        agentId: sidecar.friendlyIds?.agentId ?? r.agentId,
        beatNumber: r.beatNumber,
        trigger,
        startedAt: r.startedAt?.toISOString() ?? new Date().toISOString(),
        endedAt: r.finishedAt?.toISOString() ?? null,
        status: legacyStatus,
        snapshotVersionRead: sidecar.snapshotVersionRead ?? null,
        snapshotVersionWritten: sidecar.snapshotVersionWritten ?? null,
        phases: sidecar.phases ?? {},
        outcome: sidecar.outcome ?? null,
        totalTokens: r.totalTokens ?? 0,
        costCents: r.totalCostCents ?? 0,
        errorMessage: sidecar.errorMessage ?? r.cause ?? null,
        summary: sidecar.summary ?? null,
      };
    });
  } catch (err) {
    console.warn("[CP] Failed to load beat history from DB:", err instanceof Error ? err.message : err);
    return [];
  }
}

/** Get the current snapshot version (for optimistic concurrency). */
export function cpGetSnapshotVersion(): number {
  return snapshotVersion;
}

/**
 * Commit a structured task result when a beat completes a task.
 * Sets task status to completed, stores result artifacts in executorState,
 * and emits an audit event.
 *
 * Spec 31 Phase 7.C.d-cp — async; reads the task from canonical via
 * the tasks repo so the result append works on real DB state.
 */
export async function cpCommitTaskResult(
  companyId: string,
  taskId: string,
  result: TaskResult,
): Promise<void> {
  const task = await tasksRepo.findByIdHydrated(getDb(), taskId);
  if (!task) {
    console.warn(`[CP] cpCommitTaskResult: task ${taskId} not found`);
    return;
  }

  // Store structured result in executorState.results (capped at 50 entries)
  const existingResults = task.executorState.results ?? [];
  const resultEntry = `[${result.beatId}] ${result.summary}`;
  const updatedResults = [...existingResults, resultEntry].slice(-50);

  await updateTask(taskId, (t) => ({
    ...t,
    status: "completed" as const,
    completedAt: new Date().toISOString(),
    executorState: {
      ...t.executorState,
      results: updatedResults,
    },
    verifierState: {
      ...t.verifierState,
      isVerified: true,
      feedback: result.summary.slice(0, 300),
    },
  }));

  audit({
    companyId,
    category: "agent_action",
    eventType: "task_result_committed",
    summary: `Task ${taskId} completed via beat ${result.beatId}: ${result.summary.slice(0, 200)}`,
    detail: {
      taskId,
      beatId: result.beatId,
      artifacts: result.artifacts,
      filesModified: result.filesModified,
      tokensUsed: result.tokensUsed,
    },
  });
}

// ── Build Status Check (for heartbeat checklist) ───────────

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Cached last build check result (refreshed on demand). */
let lastBuildCheck: { status: "ok" | "error" | "unknown"; detail: string; checkedAt: string } = {
  status: "unknown", detail: "Not yet checked", checkedAt: new Date().toISOString(),
};

/**
 * Run a build check in the product workspace directory.
 * Updates the cached result and returns it.
 * Called periodically or before beats for CTO/developer roles.
 */
export function cpRunBuildCheck(productDir: string): typeof lastBuildCheck {
  if (!existsSync(productDir)) {
    lastBuildCheck = { status: "unknown", detail: `Product dir does not exist: ${productDir}`, checkedAt: new Date().toISOString() };
    return lastBuildCheck;
  }

  const pkgPath = join(productDir, "package.json");
  if (!existsSync(pkgPath)) {
    lastBuildCheck = { status: "ok", detail: "No package.json — no build check applicable", checkedAt: new Date().toISOString() };
    return lastBuildCheck;
  }

  try {
    // Prefer `npm run build` if it exists, otherwise `npx tsc --noEmit`
    let cmd = "npx tsc --noEmit";
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { scripts?: Record<string, string> };
      if (pkg.scripts?.build) cmd = "npm run build";
    } catch { /* use default */ }

    // `shell: true` works at runtime but the @types/node overload only allows
    // string | URL. We cast through `string` to satisfy the overload without
    // disabling type-checking on the rest of the call site.
    execSync(cmd, { cwd: productDir, timeout: 30_000, stdio: "pipe", shell: true as unknown as string });
    lastBuildCheck = { status: "ok", detail: `Build passed (${cmd})`, checkedAt: new Date().toISOString() };
  } catch (err: unknown) {
    // execSync errors carry a `stderr: Buffer` field but @types/node only
    // surfaces it on the rejected-promise path, not the thrown one. Read it
    // through a narrowed shape rather than `any`.
    const errWithStderr = err as { stderr?: { toString?: () => string } };
    const stderr = errWithStderr.stderr?.toString?.().slice(0, 500) ?? "";
    lastBuildCheck = { status: "error", detail: stderr || "Build failed", checkedAt: new Date().toISOString() };
  }

  return lastBuildCheck;
}

/** Get the cached last build check result. */
export function cpGetLastBuildCheck() {
  return lastBuildCheck;
}

// ── Spec 13: Trust Score CRUD ───────────────────────────────

/** In-memory cache for trust scores (populated from DB on first load). */
const trustScoreCache = new Map<string, TrustScore>();

/**
 * Set to true on first 42P01 (`relation "trust_scores" does not exist`).
 * Subsequent calls bypass the DB silently — the in-memory cache becomes the
 * source of truth until migration 0020 is applied. Without this guard every
 * beat would emit a noisy `[Governance] Failed to …` warning.
 */
let trustScoresTableMissing = false;

function noteTrustTableMissing(scope: string, err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  const msg = err instanceof Error ? err.message : String(err);
  if (code === "42P01" || /relation .*trust_scores.* does not exist/i.test(msg)) {
    if (!trustScoresTableMissing) {
      trustScoresTableMissing = true;
      console.warn(`[Governance] trust_scores table missing — running with in-memory cache only (apply migration 0020). First seen during ${scope}.`);
    }
    return true;
  }
  return false;
}

/** Load trust score from cache or DB. Returns initial score if not found. */
export async function cpLoadTrustScore(agentId: string): Promise<TrustScore> {
  if (trustScoreCache.has(agentId)) {
    return trustScoreCache.get(agentId)!;
  }

  if (isDatabaseConfigured() && !trustScoresTableMissing) {
    try {
      const db = getDb();
      const rows = await db.select().from(trustScoresTable).where(eq(trustScoresTable.agentId, agentId)).limit(1);
      if (rows.length > 0) {
        const row = rows[0];
        const ts: TrustScore = {
          agentId: row.agentId,
          score: row.score,
          history: (row.history as TrustScore["history"]) ?? [],
          updatedAt: row.updatedAt?.toISOString() ?? new Date().toISOString(),
        };
        trustScoreCache.set(agentId, ts);
        return ts;
      }
    } catch (err) {
      if (!noteTrustTableMissing(`load(${agentId})`, err)) {
        console.warn(`[Governance] Failed to load trust score for ${agentId}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  // Create initial trust score
  const initial = createInitialTrust(agentId, new Date().toISOString());
  trustScoreCache.set(agentId, initial);
  return initial;
}

/** Update trust score: apply event, persist to cache + DB. */
export async function cpUpdateTrustScore(event: TrustEvent): Promise<TrustScore> {
  const current = await cpLoadTrustScore(event.agentId);
  const updated = adjustTrust(current, event);
  trustScoreCache.set(event.agentId, updated);

  emitEmployeeActivity("system", "decision", `Trust updated for ${event.agentId}: ${current.score.toFixed(3)} → ${updated.score.toFixed(3)} (${event.kind}: ${event.reason})`, {
    detail: {
      agentId: event.agentId,
      previousScore: current.score,
      newScore: updated.score,
      delta: updated.score - current.score,
      kind: event.kind,
      tier: getTrustTier(updated.score),
    },
  });

  // Persist to DB (non-blocking)
  if (isDatabaseConfigured() && !trustScoresTableMissing) {
    try {
      const db = getDb();
      // The legacy trust_scores table in tables.ts declares `history` as a
      // bare `jsonb` without a `$type<TrustEvent[]>()` annotation, so drizzle
      // infers it as `unknown`. The contract-typed `updated.history` is
      // structurally identical; cast through `unknown` to satisfy drizzle
      // without losing type-safety on the rest of the values object.
      const trustHistory = updated.history as unknown as Record<string, unknown>;
      await db.insert(trustScoresTable).values({
        agentId: updated.agentId,
        score: updated.score,
        history: trustHistory,
        updatedAt: new Date(updated.updatedAt),
      }).onConflictDoUpdate({
        target: trustScoresTable.agentId,
        set: {
          score: updated.score,
          history: trustHistory,
          updatedAt: new Date(updated.updatedAt),
        },
      });
    } catch (err) {
      if (!noteTrustTableMissing(`persist(${event.agentId})`, err)) {
        console.warn(`[Governance] Failed to persist trust score for ${event.agentId}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  return updated;
}

// ── Policy violations — Spec 31 Phase 7.B.5.3 ──────────────
//
// Migrated from the legacy `policy_violations` text-PK table to the
// canonical `policy_violations` (uuid PK, FK to companies/agents/
// heartbeat_runs). The contract `PolicyViolation` shape is unchanged;
// friendly id ↔ uuid translation happens at the repo boundary using
// `friendlyToUuid` and a `_friendlyIds` sidecar in the `detail` field
// is not necessary because:
//   • `id` round-trips deterministically via friendlyToUuid (idempotent
//     on a uuid string).
//   • `companyId` / `agentId` round-trip via companiesRepo / agentsRepo
//     `fromDbId` (no friendly_id column on policy_violations canonical;
//     callers join through companies/agents to get friendly form when
//     needed).
//   • `beatId` round-trips the same way (heartbeat_runs has no friendly
//     column either).
//
// The legacy contract `PolicyViolation.agentId` is required (string).
// The canonical schema allows null `agent_id` for system-scoped denies
// (pre-strategy). When reading, a null agent uuid surfaces as the empty
// string — callers already gate on `agentId` truthiness for filtering.

/** Record a policy violation to cache + canonical DB. */
export async function cpRecordPolicyViolation(violation: PolicyViolation): Promise<void> {
  // Push to recent violations cache
  recentViolationsCache.push(violation);
  if (recentViolationsCache.length > 500) recentViolationsCache.splice(0, recentViolationsCache.length - 500);

  emitEmployeeActivity("system", "decision", `Policy violation recorded: agent=${violation.agentId} tool=${violation.tool} rule=${violation.ruleId} severity=${violation.severity}`, {
    detail: {
      violationId: violation.id,
      agentId: violation.agentId,
      tool: violation.tool,
      ruleId: violation.ruleId,
      decision: violation.decision,
      severity: violation.severity,
      detail: violation.detail,
    },
  });

  if (isDatabaseConfigured()) {
    try {
      const db = getDb();
      await db.insert(policyViolationsCanonical).values({
        id: friendlyToUuid(violation.id),
        companyId: companiesRepo.toDbId(violation.companyId),
        agentId: violation.agentId ? agentsRepo.toDbId(violation.agentId) : null,
        ruleId: violation.ruleId,
        tool: violation.tool,
        decision: violation.decision,
        severity: violation.severity,
        detail: violation.detail,
        beatId: violation.beatId ? friendlyToUuid(violation.beatId) : null,
        resolvedAt: violation.resolvedAt ? new Date(violation.resolvedAt) : null,
        createdAt: new Date(violation.createdAt),
      });
    } catch (err) {
      console.warn(`[Governance] Failed to persist policy violation:`, err instanceof Error ? err.message : err);
    }
  }
}

/** Get recent policy violations (from canonical DB or in-memory cache fallback). */
export async function cpGetPolicyViolations(opts?: { agentId?: string; limit?: number }): Promise<PolicyViolation[]> {
  const limit = opts?.limit ?? 50;

  if (isDatabaseConfigured()) {
    try {
      const db = getDb();
      const conditions = opts?.agentId
        ? eq(policyViolationsCanonical.agentId, agentsRepo.toDbId(opts.agentId))
        : undefined;
      const rows = await db.select().from(policyViolationsCanonical)
        .where(conditions)
        .orderBy(desc(policyViolationsCanonical.createdAt))
        .limit(limit);
      return rows.map((r) => ({
        id: r.id,
        companyId: r.companyId,
        // The canonical schema allows null agent_id for system-scoped
        // denies; the contract requires a string. Surface as empty
        // string so consumers can gate on `agentId.length`.
        agentId: r.agentId ?? "",
        ruleId: r.ruleId,
        tool: r.tool,
        decision: r.decision as PolicyViolation["decision"],
        severity: r.severity as PolicyViolation["severity"],
        detail: r.detail,
        beatId: r.beatId,
        resolvedAt: r.resolvedAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      }));
    } catch (err) {
      console.warn(`[Governance] Failed to load violations from DB:`, err instanceof Error ? err.message : err);
    }
  }

  // Fallback: return from in-memory cache
  let results = [...recentViolationsCache];
  if (opts?.agentId) results = results.filter((v) => v.agentId === opts.agentId);
  return results.slice(-limit).reverse();
}

/** Get all cached trust scores. */
export function cpGetAllTrustScores(): TrustScore[] {
  return Array.from(trustScoreCache.values());
}

/** Load all trust scores from DB into cache. Called at startup. */
export async function cpHydrateTrustScores(): Promise<void> {
  if (!isDatabaseConfigured()) return;
  try {
    const db = getDb();
    const rows = await db.select().from(trustScoresTable);
    for (const row of rows) {
      trustScoreCache.set(row.agentId, {
        agentId: row.agentId,
        score: row.score,
        history: (row.history as TrustScore["history"]) ?? [],
        updatedAt: row.updatedAt?.toISOString() ?? new Date().toISOString(),
      });
    }
    emitEmployeeActivity("system", "info", `Governance: hydrated ${rows.length} trust scores from DB`);
  } catch (err) {
    if (!noteTrustTableMissing("hydrate", err)) {
      console.warn(`[Governance] Failed to hydrate trust scores:`, err instanceof Error ? err.message : err);
    }
  }
}

/** In-memory recent violations cache. */
const recentViolationsCache: PolicyViolation[] = [];

/**
 * Initialize trust scores for a freshly hired roster of agents.
 * Spec 31 Phase 7.C.d-cp — replaces the old `storeEvents.on("agents-hired", …)`
 * listener that fired from `store.applyStrategy`. Now called explicitly
 * by `applyStrategyTx` after the transaction commits. Fire-and-forget;
 * failures are warned but never thrown.
 */
export async function cpInitializeAgentTrust(agents: { id: string }[]): Promise<void> {
  const nowIso = new Date().toISOString();
  const results = await Promise.allSettled(
    agents.map((a) =>
      cpUpdateTrustScore({
        agentId: a.id,
        kind: "manual_adjustment",
        delta: 0,
        reason: "Agent hired — initial trust",
        timestamp: nowIso,
      }),
    ),
  );
  const failed = results.filter((r) => r.status === "rejected").length;
  if (failed > 0) {
    console.warn(`[Trust] init failed for ${failed}/${agents.length} agents`);
  }
}
