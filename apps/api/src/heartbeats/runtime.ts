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

/**
 * Cursor for rotating which company gets the lead position in the
 * roster each tick. Bumped once per `getAgentRoster()` call so that
 * over N ticks (N = number of non-paused companies) each tenant
 * lands first exactly once — preventing the alphabetically-first
 * company from monopolising both maxConcurrentBeats slots when
 * overdueness ties.
 */
let rosterRotationCursor = 0;

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
      // Return agents for ALL companies so the engine schedules beats for
      // every user in parallel. Companies in the paused set are excluded
      // so individual users can stop/resume without affecting others.
      //
      // Tenant fairness — two structural moves so one user can't starve
      // another when maxConcurrentBeats >= 2:
      //
      //   1. Rotate company order each tick (rosterRotationCursor).
      //      Over N ticks each tenant is the lead company exactly once,
      //      so the stable-sort tiebreaker in HeartbeatEngine.tick doesn't
      //      hand every slot to the alphabetically-first company.
      //
      //   2. Interleave (round-robin) by agent index within each company,
      //      so the roster reads [A.ceo, B.ceo, A.cto, B.cto, ...] not
      //      [A.ceo, A.cto, …A.skills_lead, B.ceo, …]. Without this, the
      //      engine sees all of A's same-priority roles before any of B's,
      //      and a full slot count of A's roles fires before B's first
      //      beat lands.
      const db = getDb();
      const companies = await companiesRepo.listCompanies(db);
      const nonPaused = companies
        .map(c => companiesRepo.fromDbId(c.id, c.friendlyId))
        .filter(id => !pausedCompanies.has(id));
      const results = await Promise.all(
        nonPaused.map(companyId =>
          agentsRepo.listAgentsByCompany(db, companyId).then(agents => ({ companyId, agents })),
        ),
      );

      // (1) Rotating lead. Spliced rotation rather than slicing so
      // the relative order of trailing companies stays stable.
      if (results.length > 1) {
        const offset = rosterRotationCursor % results.length;
        rosterRotationCursor = (rosterRotationCursor + 1) >>> 0;
        if (offset > 0) {
          results.push(...results.splice(0, offset));
        }
      }

      // (2) Round-robin zip across companies by agent index.
      const roster: { agentId: string; role: ReturnType<typeof parseRoleStrict>; companyId: string }[] = [];
      const maxLen = results.reduce((m, r) => Math.max(m, r.agents.length), 0);
      for (let i = 0; i < maxLen; i++) {
        for (const { companyId, agents } of results) {
          const a = agents[i];
          if (!a) continue;
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
