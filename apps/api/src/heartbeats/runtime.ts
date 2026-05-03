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
import { parseRoleStrict } from "@arceus/contracts";
import { HeartbeatEngine, emitBeatEvent } from "@arceus/company-runtime";
import type { BeatDependencies } from "@arceus/company-runtime";
import { heartbeatConfig } from "../config/heartbeat.js";
import { audit } from "../observability/audit-ledger.js";
import { setReactiveEventEmitter } from "../orchestration/state.js";
import { runBeat } from "../orchestration/run-beat.js";
import { getActiveCompanyId } from "../persistence/active-company.js";
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
      // Vision: orchestrator hands the beat to runBeat. The agent reads its open
      // tasks from rendered state and claims one via `task_claim`. No taskId
      // pre-selection. See plans/agent-redesign/00-vision.md.
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
      // Spec 31 Phase 7.C.c — async, reads agents from canonical via repo.
      const companyId = getActiveCompanyId();
      if (!companyId) return [];
      const agents = await agentsRepo.listAgentsByCompany(getDb(), companyId);
      return agents.map((a) => ({
        agentId: a.id,
        role: parseRoleStrict(a.role),
        companyId,
      }));
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
