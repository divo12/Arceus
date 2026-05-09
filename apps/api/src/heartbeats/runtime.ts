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
import {
  cpApplyMutations,
  cpCommitBeatRecord,
  cpGetSnapshotVersion,
  cpLoadAgentContext,
} from "../persistence/control-plane/index.js";
import { flush } from "../persistence/mutations/index.js";
import { executeChecklistAction } from "./checklist-executor.js";

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
    loadAgentContext: async (agentId, beatId, beatNumber, trigger, config) =>
      cpLoadAgentContext(agentId, beatId, beatNumber, trigger, config),
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
        toolCalls: 0,
        completed: result.verdict === "pass",
      };
    },
    executeChecklistAction: (ctx, action, beatId) => executeChecklistAction(ctx, action, beatId),
    getAgentRoster: async () => {
      // Return agents for ALL companies so the engine schedules beats for
      // every user in parallel. Companies in the paused set are excluded
      // so individual users can stop/resume without affecting others.
      const db = getDb();
      const companies = await companiesRepo.listCompanies(db);
      const roster: { agentId: string; role: ReturnType<typeof parseRoleStrict>; companyId: string }[] = [];
      const nonPaused = companies
        .map(c => companiesRepo.fromDbId(c.id, c.friendlyId))
        .filter(id => !pausedCompanies.has(id));
      const results = await Promise.all(
        nonPaused.map(companyId =>
          agentsRepo.listAgentsByCompany(db, companyId).then(agents => ({ companyId, agents })),
        ),
      );
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
    roleHasClaimableWork: (companyId, role) =>
      hasClaimableTasksForRole(getDb(), companyId, role),
    emitBeatEvent: (event) => { emitBeatEvent(event); },
  };

  const engine = new HeartbeatEngine(heartbeatConfig, beatDeps);

  // Wire reactive events: orchestrator mutations → heartbeat engine event-triggered beats
  setReactiveEventEmitter((companyId, agentId, role, event) =>
    { engine.emitEvent(companyId, agentId, role, event); }
  );

  return { engine };
}
