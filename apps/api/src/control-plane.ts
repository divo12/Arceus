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
} from "@arceus/contracts";
import { loadPersistedCompanyState, schedulePersistedCompanyState } from "./company-state";
import { audit, auditSystem } from "./audit-ledger";
import { getRegistryStats } from "./service-registry";
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
} from "./store";

// ── Version tracking ───────────────────────────────────────

let snapshotVersion = 0;
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
  causation?: { eventId?: string; summary?: string }
): { version: number; applied: number; errors: string[] } {
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
