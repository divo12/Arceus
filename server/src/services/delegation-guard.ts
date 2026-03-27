import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { roleDefinitionService } from "./role-definitions.js";

interface DelegationCheckResult {
  allowed: boolean;
  reason: string;
}

export function delegationGuardService(db: Db) {
  const roleDefs = roleDefinitionService(db);

  async function canDelegate(fromAgentId: string, toAgentId: string): Promise<DelegationCheckResult> {
    if (fromAgentId === toAgentId) {
      return { allowed: true, reason: "Self-assignment is allowed" };
    }

    const [fromAgent, toAgent, fromRole] = await Promise.all([
      db
        .select({ kind: agents.kind, companyId: agents.companyId })
        .from(agents)
        .where(eq(agents.id, fromAgentId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ role: agents.role, kind: agents.kind, companyId: agents.companyId })
        .from(agents)
        .where(eq(agents.id, toAgentId))
        .then((rows) => rows[0] ?? null),
      roleDefs.getForAgent(fromAgentId),
    ]);

    if (!fromAgent) {
      return { allowed: false, reason: "Requesting agent not found" };
    }
    if (fromAgent.kind === "spawned") {
      return { allowed: false, reason: "Spawned agents cannot delegate" };
    }
    if (!toAgent) {
      return { allowed: false, reason: "Target agent not found" };
    }
    if (fromAgent.companyId !== toAgent.companyId) {
      return { allowed: false, reason: "Agents must belong to the same company" };
    }
    if (toAgent.kind === "spawned") {
      return { allowed: false, reason: "Spawned agents cannot receive delegated work" };
    }
    if (!fromRole) {
      return { allowed: true, reason: "No role definition — permissive fallback" };
    }
    if (fromRole.canDelegateTo.includes(toAgent.role as (typeof fromRole.canDelegateTo)[number])) {
      return { allowed: true, reason: "Allowed by role delegation matrix" };
    }
    return {
      allowed: false,
      reason: `${fromRole.label} cannot delegate to ${toAgent.role}`,
    };
  }

  async function assertCanDelegate(fromAgentId: string, toAgentId: string) {
    const result = await canDelegate(fromAgentId, toAgentId);
    if (!result.allowed) {
      throw forbidden(result.reason);
    }
  }

  async function getDelegationAuthority(agentId: string) {
    const roleDef = await roleDefs.getForAgent(agentId);
    if (!roleDef) {
      return {
        canDelegateTo: [],
        delegationStyle: "collaborative" as const,
      };
    }
    return {
      canDelegateTo: roleDef.canDelegateTo,
      delegationStyle: roleDef.delegationStyle,
    };
  }

  function validateDelegationChain(agentIds: string[]): DelegationCheckResult {
    const seen = new Set<string>();
    for (const id of agentIds) {
      if (seen.has(id)) {
        return { allowed: false, reason: `Cycle detected: agent ${id} appears twice in chain` };
      }
      seen.add(id);
    }
    if (agentIds.length > 3) {
      return { allowed: false, reason: `Delegation depth ${agentIds.length} exceeds maximum of 3` };
    }
    return { allowed: true, reason: "Chain valid" };
  }

  return {
    canDelegate,
    assertCanDelegate,
    getDelegationAuthority,
    validateDelegationChain,
  };
}
