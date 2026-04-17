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
import { loadPersistedCompanyState, schedulePersistedCompanyState } from "./company-state";
import { audit, auditSystem } from "./audit-ledger";
import { emitEmployeeActivity } from "./activity";
import { getRegistryStats, getToolsForRole } from "./service-registry";
import { isDatabaseConfigured, getDb } from "@arceus/db";
import { beatRecordsTable, trustScoresTable, policyViolationsTable } from "@arceus/db";
import { desc, eq, and, sql } from "drizzle-orm";
import {
  createInitialTrust,
  adjustTrust,
  buildTrustEvent,
  getTrustTier,
  filterToolsForAgent,
  summarizeFilterResult,
  BASE_POLICY_RULES,
  TRUST_CONFIG,
} from "@arceus/company-runtime";
import type { TrustScore, TrustEvent, PolicyViolation } from "@arceus/contracts";
import {
  getSnapshot,
  getEvents,
  getStoreLifecycleState,
  upsertTask,
  updateTask,
  upsertSprint,
  updateSprint,
  upsertMeeting,
  upsertApproval,
  updateApproval,
  appendChatMessage,
  appendTransition,
  updateTransition,
  updateAgentStatus,
  updateCompanyStatus,
  updateTaskProgress,
} from "./store";

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

/** Load the full snapshot. For now wraps store.getSnapshot(). */
export function cpLoadSnapshot(): CompanySnapshot & { _version: number } {
  return { ...getSnapshot(), _version: snapshotVersion };
}

/** Load from persisted DB (cold start). */
export async function cpLoadPersistedSnapshot(companyId?: string) {
  const persisted = await loadPersistedCompanyState(companyId);
  if (persisted) {
    snapshotVersion = 0; // reset on hydrate
    mutationCount = 0;
  }
  return persisted;
}

/** Get the current version info. */
export function cpGetVersion(): SnapshotVersion {
  const snap = getSnapshot();
  return {
    companyId: snap.company.id,
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
 * Each mutation is applied to the in-memory store and audited.
 * Returns the new snapshot version.
 */
export function cpApplyMutations(
  companyId: string,
  mutations: StateMutation[],
  causation?: { eventId?: string; summary?: string },
  expectedVersion?: number
): { version: number; applied: number; errors: string[] } {
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
      applyOneMutation(companyId, mutation, causation?.eventId);
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

  // Persist after mutations
  const snapshot = getSnapshot();
  void schedulePersistedCompanyState(snapshot, getEvents()).catch(() => {});

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

function applyOneMutation(companyId: string, mutation: StateMutation, causationId?: string) {
  switch (mutation.type) {
    case "task_status":
      updateTask(mutation.taskId, (t) => ({
        ...t,
        status: mutation.status as any,
        ...(mutation.summary ? { summary: mutation.summary } : {}),
      }));
      break;

    case "task_assign":
      updateTask(mutation.taskId, (t) => ({
        ...t,
        assignedTo: mutation.agentId,
      }));
      break;

    case "task_create":
      upsertTask(mutation.task as any);
      break;

    case "sprint_status":
      updateSprint(mutation.sprintId, (s) => ({
        ...s,
        status: mutation.status as any,
      }));
      break;

    case "sprint_create":
      upsertSprint(mutation.sprint as any);
      break;

    case "meeting_record":
      upsertMeeting(mutation.meeting as any);
      break;

    case "approval_create":
      upsertApproval(mutation.approval as any);
      break;

    case "approval_resolve":
      updateApproval(mutation.approvalId, (a) => ({
        ...a,
        status: mutation.status as "approved" | "rejected",
      }));
      break;

    case "chat_message":
      appendChatMessage(mutation.message as any);
      break;

    case "transition_append":
      appendTransition(mutation.transition as any);
      break;

    case "transition_update":
      updateTransition(mutation.transitionId, (t) => ({
        ...t,
        ...mutation.changes,
      }));
      break;

    case "agent_status":
      updateAgentStatus(mutation.agentId, mutation.status);
      break;

    case "company_status":
      updateCompanyStatus(mutation.status);
      break;

    case "task_progress":
      updateTaskProgress(mutation.taskId, mutation.progress as TaskProgress);
      break;

    default:
      throw new Error(`Unknown mutation type: ${(mutation as any).type}`);
  }
}

// ── Control Plane status / health ──────────────────────────

export type ControlPlaneStatus = {
  healthy: boolean;
  version: number;
  mutationCount: number;
  upSince: string;
  companyId: string;
  snapshotStale: boolean;
  components: {
    stateStore: { status: "ok" | "degraded"; inMemory: boolean; dbPersist: boolean; dirty: boolean; mutationsSinceHydrate: number; lastHydratedAt: string | null; lastFlushedAt: string | null };
    auditLedger: { status: "ok" | "degraded" };
    serviceRegistry: { status: "ok" | "empty"; toolCount: number; bySource: Record<string, number>; byBlastRadius: Record<string, number> };
    executionSubstrate: { status: "ok" | "idle" | "executing" };
  };
};

export function cpGetStatus(executionStatus: string): ControlPlaneStatus {
  const snap = getSnapshot();
  const isPending = snap.company.id === "company_pending";
  const regStats = getRegistryStats(snap.company.id);
  const lifecycle = getStoreLifecycleState();

  return {
    healthy: true,
    version: snapshotVersion,
    mutationCount,
    upSince: startedAt,
    companyId: snap.company.id,
    snapshotStale: lifecycle.dirty,
    components: {
      stateStore: {
        status: "ok",
        inMemory: true,
        dbPersist: !isPending,
        dirty: lifecycle.dirty,
        mutationsSinceHydrate: lifecycle.mutationsSinceHydrate,
        lastHydratedAt: lifecycle.lastHydratedAt,
        lastFlushedAt: lifecycle.lastFlushedAt,
      },
      auditLedger: {
        status: "ok",
      },
      serviceRegistry: {
        status: regStats.total > 0 ? "ok" : "empty",
        toolCount: regStats.total,
        bySource: regStats.bySource,
        byBlastRadius: regStats.byBlastRadius,
      },
      executionSubstrate: {
        status: executionStatus === "idle" ? "idle" : executionStatus === "stopped" ? "idle" : "executing",
      },
    },
  };
}

/** Snapshot summary for the dashboard (lightweight, no full data). */
export function cpGetSnapshotSummary() {
  const snap = getSnapshot();
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
 */
export function cpLoadAgentContext(
  agentId: string,
  beatId: string,
  beatNumber: number,
  trigger: BeatRecord["trigger"],
  config: { beatTokenBudget: number; beatCostCeilingCents: number }
): AgentBeatContext | null {
  const snap = getSnapshot();
  const agent = snap.agents.find((a) => a.id === agentId);
  if (!agent) return null;

  const currentSprint = snap.sprints.find((s) => s.id === snap.company.currentSprintId) ?? null;
  // CEO/PM get all sprint tasks (for sprint completion detection); others get only their own
  const agentTasks = (agent.role === "ceo" || agent.role === "pm")
    ? snap.tasks.filter((t) => t.sprintId === currentSprint?.id)
    : snap.tasks.filter(
        (t) =>
          t.assignedAgentId === agentId ||
          (t.assignedRole === agent.role && !t.assignedAgentId)
      );

  // During sprint review, tester needs visibility into bug_fix tasks tracked in
  // reviewState.bugTaskIds (typically assigned to developer) so checkBugFixesReady
  // can see their actual status instead of treating missing tasks as resolved.
  if (agent.role === "tester" && currentSprint?.status === "reviewing") {
    const reviewState = (currentSprint as any).reviewState;
    if (reviewState?.bugTaskIds?.length > 0) {
      const existingIds = new Set(agentTasks.map((t) => t.id));
      const bugTasks = snap.tasks.filter(
        (t) => (reviewState.bugTaskIds as string[]).includes(t.id) && !existingIds.has(t.id)
      );
      agentTasks.push(...bugTasks);
    }
  }

  // Collect artifact ids referenced by this agent's tasks
  const artifactIds = new Set(agentTasks.flatMap((t) => [...t.artifactIds, ...t.incomingArtifactIds]));
  const artifacts = snap.artifacts.filter((a) => artifactIds.has(a.id));

  // Tools from service registry
  const tools = getToolsForRole(snap.company.id, agent.role);
  const toolNames = tools.map((t) => t.toolName);

  // ── Governance: load trust score and filter tools (Spec 13) ──
  const agentTrustScore = trustScoreCache.get(agentId)?.score ?? TRUST_CONFIG.initialScore;
  const budgetRemaining = snap.company.budgetCents - snap.company.spentCents;
  let filteredToolNames = toolNames;
  if (budgetRemaining <= 0) {
    filteredToolNames = [];
    emitEmployeeActivity(agent.role, "decision", `Beat ${beatId}: budget exhausted — all tools denied`, { beatId, detail: { budgetRemaining, agentId } });
  } else {
    const filterResult = filterToolsForAgent(
      agent.role, agentTrustScore, toolNames, BASE_POLICY_RULES,
      snap.company.id, agentId, beatId,
    );
    filteredToolNames = filterResult.allowed;
    const summary = summarizeFilterResult(filterResult, agent.role);
    emitEmployeeActivity(agent.role, "decision", `Beat ${beatId}: ${summary}`, {
      beatId, detail: {
        trustScore: agentTrustScore,
        trustTier: getTrustTier(agentTrustScore),
        allowed: filterResult.allowed,
        denied: filterResult.denied.map(d => ({ tool: d.tool, rule: d.decision.ruleId })),
        escalated: filterResult.escalated.map(e => ({ tool: e.tool, rule: e.decision.ruleId })),
      },
    });
  }

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

  // Refresh build check for CTO/developer roles if stale (>2 min)
  if ((agent.role === "cto" || agent.role === "developer") && buildCheckProductDir) {
    const staleMs = Date.now() - new Date(lastBuildCheck.checkedAt).getTime();
    if (staleMs > 120_000 || lastBuildCheck.status === "unknown") {
      cpRunBuildCheck(buildCheckProductDir);
    }
  }

  emitEmployeeActivity(agent.role, "context", `Beat ${beatId}: context assembled — ${agentTasks.length} tasks, ${artifacts.length} artifacts, ${filteredToolNames.length}/${toolNames.length} tools (trust=${agentTrustScore.toFixed(2)}), ${agentMemory ? agentMemory.currentFocus.length + agentMemory.recentLearnings.length + agentMemory.activePatterns.length : 0} memories, ${agentHabits.length} habits, ${recentMeetings.length} meetings, ${pendingApprovals.length} approvals`, {
    beatId,
    detail: {
      agentId: agent.id,
      agentName: agent.name,
      role: agent.role,
      taskCount: agentTasks.length,
      taskIds: agentTasks.map(t => t.id),
      taskTitles: agentTasks.map(t => `[${t.status}] ${t.title}`),
      artifactCount: artifacts.length,
      toolNames,
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
  };
}

/** Load the active sprint from the snapshot (convenience). */
export function cpLoadActiveSprint() {
  const snap = getSnapshot();
  return snap.sprints.find((s) => s.id === snap.company.currentSprintId) ?? null;
}

/**
 * Commit a BeatRecord to the DB. Non-blocking — logs warning on failure.
 * Returns true if committed successfully.
 */
export async function cpCommitBeatRecord(record: BeatRecord): Promise<boolean> {
  if (!isDatabaseConfigured()) {
    return false;
  }

  try {
    const db = getDb();
    await db.insert(beatRecordsTable).values({
      id: record.id,
      companyId: record.companyId,
      agentId: record.agentId,
      beatNumber: record.beatNumber,
      trigger: record.trigger,
      startedAt: new Date(record.startedAt),
      endedAt: record.endedAt ? new Date(record.endedAt) : null,
      status: record.status,
      snapshotVersionRead: record.snapshotVersionRead,
      snapshotVersionWritten: record.snapshotVersionWritten,
      phases: record.phases,
      outcome: record.outcome,
      totalTokens: record.totalTokens,
      costCents: String(record.costCents),
      errorMessage: record.errorMessage,
      summary: record.summary,
    });
    return true;
  } catch (err) {
    console.warn("[CP] Failed to commit beat record:", err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * Retrieve beat history from DB. Falls back to empty array if DB is unavailable.
 */
export async function cpGetBeatHistory(
  companyId: string,
  opts?: { limit?: number; agentId?: string },
): Promise<BeatRecord[]> {
  if (!isDatabaseConfigured()) return [];

  try {
    const db = getDb();
    const limit = opts?.limit ?? 100;
    const conditions = [eq(beatRecordsTable.companyId, companyId)];
    if (opts?.agentId) conditions.push(eq(beatRecordsTable.agentId, opts.agentId));

    const rows = await db
      .select()
      .from(beatRecordsTable)
      .where(conditions.length === 1 ? conditions[0] : and(...conditions))
      .orderBy(desc(beatRecordsTable.startedAt))
      .limit(limit);

    return rows.map((r) => ({
      id: r.id,
      companyId: r.companyId,
      agentId: r.agentId ?? null,
      beatNumber: r.beatNumber,
      trigger: r.trigger as BeatRecord["trigger"],
      startedAt: r.startedAt?.toISOString() ?? new Date().toISOString(),
      endedAt: r.endedAt?.toISOString() ?? null,
      status: r.status as BeatRecord["status"],
      snapshotVersionRead: r.snapshotVersionRead ?? null,
      snapshotVersionWritten: r.snapshotVersionWritten ?? null,
      phases: (r.phases ?? {}) as BeatRecord["phases"],
      outcome: (r.outcome as BeatRecord["outcome"]) ?? null,
      totalTokens: r.totalTokens ?? 0,
      costCents: Number(r.costCents) || 0,
      errorMessage: r.errorMessage ?? null,
      summary: r.summary ?? null,
    }));
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
 */
export function cpCommitTaskResult(
  companyId: string,
  taskId: string,
  result: TaskResult,
): void {
  const snap = getSnapshot();
  const task = snap.tasks.find((t) => t.id === taskId);
  if (!task) {
    console.warn(`[CP] cpCommitTaskResult: task ${taskId} not found`);
    return;
  }

  // Store structured result in executorState.results (capped at 50 entries)
  const existingResults = task.executorState.results ?? [];
  const resultEntry = `[${result.beatId}] ${result.summary}`;
  const updatedResults = [...existingResults, resultEntry].slice(-50);

  updateTask(taskId, (t) => ({
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
      const pkg = JSON.parse(require("node:fs").readFileSync(pkgPath, "utf-8"));
      if (pkg.scripts?.build) cmd = "npm run build";
    } catch { /* use default */ }

    execSync(cmd, { cwd: productDir, timeout: 30_000, stdio: "pipe", shell: true as any });
    lastBuildCheck = { status: "ok", detail: `Build passed (${cmd})`, checkedAt: new Date().toISOString() };
  } catch (err: unknown) {
    const stderr = (err as any)?.stderr?.toString?.()?.slice(0, 500) ?? "";
    lastBuildCheck = { status: "error", detail: stderr || "Build failed", checkedAt: new Date().toISOString() };
  }

  return lastBuildCheck;
}

export function cpGetLastBuildCheck() {
  return lastBuildCheck;
}

// ── Spec 13: Trust Score CRUD ───────────────────────────────

/** In-memory cache for trust scores (populated from DB on first load). */
const trustScoreCache = new Map<string, TrustScore>();

/** Load trust score from cache or DB. Returns initial score if not found. */
export async function cpLoadTrustScore(agentId: string): Promise<TrustScore> {
  if (trustScoreCache.has(agentId)) {
    return trustScoreCache.get(agentId)!;
  }

  if (isDatabaseConfigured()) {
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
      console.warn(`[Governance] Failed to load trust score for ${agentId}:`, err instanceof Error ? err.message : err);
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
  if (isDatabaseConfigured()) {
    try {
      const db = getDb();
      await db.insert(trustScoresTable).values({
        agentId: updated.agentId,
        score: updated.score,
        history: updated.history as any,
        updatedAt: new Date(updated.updatedAt),
      }).onConflictDoUpdate({
        target: trustScoresTable.agentId,
        set: {
          score: updated.score,
          history: updated.history as any,
          updatedAt: new Date(updated.updatedAt),
        },
      });
    } catch (err) {
      console.warn(`[Governance] Failed to persist trust score for ${event.agentId}:`, err instanceof Error ? err.message : err);
    }
  }

  return updated;
}

/** Record a policy violation to cache + DB. */
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
      await db.insert(policyViolationsTable).values({
        id: violation.id,
        companyId: violation.companyId,
        agentId: violation.agentId,
        ruleId: violation.ruleId,
        tool: violation.tool,
        decision: violation.decision,
        severity: violation.severity,
        detail: violation.detail,
        beatId: violation.beatId,
        resolvedAt: violation.resolvedAt ? new Date(violation.resolvedAt) : null,
        createdAt: new Date(violation.createdAt),
      });
    } catch (err) {
      console.warn(`[Governance] Failed to persist policy violation:`, err instanceof Error ? err.message : err);
    }
  }
}

/** Get recent policy violations (from cache or DB). */
export async function cpGetPolicyViolations(opts?: { agentId?: string; limit?: number }): Promise<PolicyViolation[]> {
  const limit = opts?.limit ?? 50;

  if (isDatabaseConfigured()) {
    try {
      const db = getDb();
      const conditions = opts?.agentId
        ? eq(policyViolationsTable.agentId, opts.agentId)
        : undefined;
      const rows = await db.select().from(policyViolationsTable)
        .where(conditions)
        .orderBy(desc(policyViolationsTable.createdAt))
        .limit(limit);
      return rows.map((r) => ({
        id: r.id,
        companyId: r.companyId,
        agentId: r.agentId,
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

  // Fallback: return from cache
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
    console.warn(`[Governance] Failed to hydrate trust scores:`, err instanceof Error ? err.message : err);
  }
}

/** In-memory recent violations cache. */
const recentViolationsCache: PolicyViolation[] = [];
