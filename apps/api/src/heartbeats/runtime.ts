/**
 * Heartbeat runtime factory.
 * Spec 12 / Spec 34 v3 PR 12.
 *
 * Constructs the BeatDependencies object + HeartbeatEngine and wires the
 * reactive event emitter. Returned engine is started by the bootstrap
 * orchestrator only after the active-company seam is hydrated.
 */
import { getDb } from "@arceus/db";
import * as agentsRepo from "@arceus/db/src/repos/agents.js";
import * as companiesRepo from "@arceus/db/src/repos/companies.js";
import { hasClaimableTasksForRole } from "@arceus/db/src/repos/tasks/index.js";
import { parseRoleStrict } from "@arceus/contracts";
import { HeartbeatEngine, emitBeatEvent } from "@arceus/company-runtime";
import type { BeatDependencies } from "@arceus/company-runtime";
import { heartbeatConfig } from "../config/heartbeat.js";
import { audit } from "../observability/audit-ledger.js";
import { setReactiveEventEmitter } from "../orchestration/state.js";
import { runBeat } from "../orchestration/run-beat.js";
import { markCompaniesLive } from "../orchestration/live-companies.js";
import {
  cpApplyMutations,
  cpCommitBeatRecord,
  cpGetSnapshotVersion,
  cpLoadAgentContext,
} from "../persistence/control-plane/index.js";
import { flush } from "../persistence/mutations/index.js";
import { executeChecklistAction } from "./checklist-executor.js";
import { sprintNeedsCeoAttention } from "../sprints/lifecycle.js";

export interface HeartbeatRuntime {
  engine: HeartbeatEngine;
}

/**
 * Per-company execution pause set.
 * A company in this set is excluded from the agent roster so the scheduler
 * never fires beats for it — without stopping the global engine and
 * interrupting other users.
 */
const pausedCompanies = new Set<string>();

export function pauseCompanyHeartbeat(companyId: string): void {
  pausedCompanies.add(companyId);
}

export function resumeCompanyHeartbeat(companyId: string): void {
  pausedCompanies.delete(companyId);
}

export function isCompanyHeartbeatPaused(companyId: string): boolean {
  return pausedCompanies.has(companyId);
}

export function createHeartbeatRuntime(): HeartbeatRuntime {
  const beatDeps: BeatDependencies = {
    loadAgentContext: async (companyId, agentId, beatId, beatNumber, trigger, config) =>
      cpLoadAgentContext(companyId, agentId, beatId, beatNumber, trigger, config),
    getSnapshotVersion: () => cpGetSnapshotVersion(),
    applyMutations: async (companyId, mutations, causation, expectedVersion) =>
      cpApplyMutations(companyId, mutations as Parameters<typeof cpApplyMutations>[1], causation, expectedVersion),
    commitBeatRecord: (record) => cpCommitBeatRecord(record),
    flushStore: () => flush(),
    audit: {
      auditAgent: (companyId, agentRole, eventType, summary, opts) =>
        { audit({ companyId, category: "agent_action", eventType, summary, agentRole, ...opts }); },
      auditSystem: (companyId, eventType, summary, opts) =>
        { audit({ companyId, category: "system", eventType, summary, ...opts }); },
      auditError: (companyId, eventType, summary, error, opts) =>
        { audit({ companyId, category: "error", severity: "error", eventType, summary, detail: { error: error instanceof Error ? error.message : error }, ...opts }); },
    },
    executeTask: async (ctx, beatId) => {
      const result = await runBeat({
        role: ctx.role,
        companyId: ctx.company.id,
        beatId,
      });
      return {
        summary: result.cause
          ? `Beat ${result.verdict} (${result.cause})`
          : `Beat ${result.verdict}`,
        tokensUsed: result.tokensUsed,
        actionsCount: 1,
        // Drained from the per-beat accumulator (azure-openai.ts), populated
        // by the MCP middleware (arceus_*) and the watchdog-reset endpoint
        // (built-in tools posted by the plugin). Replaces the historical
        // hardcoded 0 that made heartbeat_runs.tool_call_count useless.
        toolCalls: result.toolCalls,
        completed: result.verdict === "pass",
      };
    },
    executeChecklistAction: (ctx, action, beatId) => executeChecklistAction(ctx, action, beatId),
    getAgentRoster: async () => {
      // Return agents for ALL non-paused companies so the engine
      // schedules beats for every tenant in parallel.
      //
      // No fairness gymnastics here anymore: per-company semaphores
      // in HeartbeatEngine guarantee one tenant's stuck beat cannot
      // occupy another tenant's slots, regardless of roster order.
      // The old rotation cursor + round-robin zip were workarounds
      // for the previous single-global-semaphore design where roster
      // ordering decided who got slots first. With the per-company
      // pool, a tenant at its slot cap just causes the scheduler
      // loop to walk past its agents to the next tenant's.
      const db = getDb();
      const companies = await companiesRepo.listCompanies(db);
      const allCompanyIds = companies.map(c => companiesRepo.fromDbId(c.id, c.friendlyId));
      // Fail-safe tenant resolution (Phase 1): refresh the live-company set from
      // the authoritative DB list every tick so MCP resolution can reject a
      // request that resolves (via a stale session context) to a deleted company
      // instead of 500ing in buildSnapshotView. Includes paused companies — they
      // still exist.
      markCompaniesLive(allCompanyIds);
      const nonPaused = allCompanyIds.filter(id => !pausedCompanies.has(id));
      const results = await Promise.all(
        nonPaused.map(companyId =>
          agentsRepo.listAgentsByCompany(db, companyId).then(agents => ({ companyId, agents })),
        ),
      );

      const roster: { agentId: string; role: ReturnType<typeof parseRoleStrict>; companyId: string }[] = [];
      for (const { companyId, agents } of results) {
        for (const a of agents) {
          try {
            roster.push({ agentId: a.id, role: parseRoleStrict(a.role), companyId });
          } catch {
            // skip agents with unrecognised roles (e.g. legacy rows)
          }
        }
      }
      return roster;
    },
    roleHasClaimableWork: async (companyId, role) => {
      if (await hasClaimableTasksForRole(getDb(), companyId, role)) return true;
      // Sprint progression — the CEO owns no claimable task once a
      // sprint's work is done, so the task-only check above returns false
      // and the scheduler would never wake it to finalize the sprint +
      // plan the next one (fully-completed sprint goes idle forever;
      // observed live 2026-06-13). Wake the CEO when the active sprint
      // needs finalization or the next-sprint plan.
      if (role === "ceo") return sprintNeedsCeoAttention(companyId);
      return false;
    },
    emitBeatEvent: (event) => { emitBeatEvent(event); },
  };

  const engine = new HeartbeatEngine(heartbeatConfig, beatDeps);

  // Wire reactive events: orchestrator mutations → heartbeat engine event-triggered beats
  setReactiveEventEmitter((companyId, agentId, role, event) =>
    { engine.emitEvent(companyId, agentId, role, event); }
  );

  return { engine };
}
