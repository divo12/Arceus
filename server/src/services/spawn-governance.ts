import { and, eq, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import type { AgentRole } from "@paperclipai/shared";
import { isEmployeeRole } from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { roleDefinitionService } from "./role-definitions.js";

const TERMINATED_AGENT_STATUSES = ["terminated"] as const;

interface SpawnCheckResult {
  allowed: boolean;
  reason: string;
}

export function spawnGovernanceService(db: Db) {
  const roleDefs = roleDefinitionService(db);

  async function getActiveSpawnCount(agentId: string): Promise<number> {
    const rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(agents)
      .where(and(
        eq(agents.kind, "spawned"),
        eq(agents.spawnedByAgentId, agentId),
        notInArray(agents.status, [...TERMINATED_AGENT_STATUSES]),
      ));
    return rows[0]?.count ?? 0;
  }

  async function checkSpawnBudget(agentId: string) {
    const [roleDef, activeCount] = await Promise.all([
      roleDefs.getForAgent(agentId),
      getActiveSpawnCount(agentId),
    ]);

    const max = roleDef?.spawnRules.maxConcurrentSpawns ?? 0;
    return {
      active: activeCount,
      max,
      remaining: Math.max(0, max - activeCount),
      allowedTypes: roleDef?.spawnRules.allowedAgentTypes ?? [],
    };
  }

  async function canSpawn(requestingAgentId: string, targetRole: AgentRole): Promise<SpawnCheckResult> {
    const [requestingAgent, roleDef] = await Promise.all([
      db.select({ kind: agents.kind }).from(agents).where(eq(agents.id, requestingAgentId)).then((rows) => rows[0] ?? null),
      roleDefs.getForAgent(requestingAgentId),
    ]);

    if (!requestingAgent) {
      return { allowed: false, reason: "Requesting agent not found" };
    }
    if (requestingAgent.kind === "spawned") {
      return { allowed: false, reason: "Spawned agents cannot spawn other agents" };
    }
    if (isEmployeeRole(targetRole)) {
      return {
        allowed: false,
        reason: `Employee role "${targetRole}" cannot be spawned — must be hired by Board`,
      };
    }
    if (!roleDef) {
      return { allowed: true, reason: "No role definition — permissive fallback" };
    }
    if (!roleDef.spawnRules.allowedAgentTypes.includes(targetRole)) {
      return {
        allowed: false,
        reason: `${roleDef.label} cannot spawn ${targetRole} agents`,
      };
    }

    const budget = await checkSpawnBudget(requestingAgentId);
    if (budget.remaining <= 0) {
      return {
        allowed: false,
        reason: `${roleDef.label} has reached max concurrent spawns (${budget.max})`,
      };
    }

    return { allowed: true, reason: "Allowed by spawn rules" };
  }

  async function assertCanSpawn(requestingAgentId: string, targetRole: AgentRole) {
    const result = await canSpawn(requestingAgentId, targetRole);
    if (!result.allowed) {
      throw forbidden(result.reason);
    }
  }

  return {
    canSpawn,
    assertCanSpawn,
    getActiveSpawnCount,
    checkSpawnBudget,
  };
}
