import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import type { DelegationStyle } from "@paperclipai/shared";
import { agents, agentWakeupRequests } from "@paperclipai/db";
import type { ParsedIssueAssigneeAdapterOverrides } from "./types.js";
import { formatOrgRoleLabel } from "./helpers.js";
import { parseObject } from "../../adapters/utils.js";

export function parseIssueAssigneeAdapterOverrides(
  raw: unknown,
): ParsedIssueAssigneeAdapterOverrides | null {
  const parsed = parseObject(raw);
  const parsedAdapterConfig = parseObject(parsed.adapterConfig);
  const adapterConfig =
    Object.keys(parsedAdapterConfig).length > 0 ? parsedAdapterConfig : null;
  const useProjectWorkspace =
    typeof parsed.useProjectWorkspace === "boolean"
      ? parsed.useProjectWorkspace
      : null;
  if (!adapterConfig && useProjectWorkspace === null) return null;
  return {
    adapterConfig,
    useProjectWorkspace,
  };
}

export function createOrgContextOps(db: Db) {
  async function resolveOrgPosition(agent: typeof agents.$inferSelect) {
    if (agent.kind === "spawned") {
      return {
        reportsTo: null,
        directReports: [] as string[],
      };
    }

    const [manager, directReports] = await Promise.all([
      agent.reportsTo
        ? db
            .select({ name: agents.name, role: agents.role })
            .from(agents)
            .where(eq(agents.id, agent.reportsTo))
            .then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
      db
        .select({ name: agents.name, role: agents.role })
        .from(agents)
        .where(and(eq(agents.reportsTo, agent.id), eq(agents.kind, "employee"))),
    ]);

    return {
      reportsTo: manager ? `${formatOrgRoleLabel(manager.role)} (${manager.name})` : null,
      directReports: directReports.map((report) => `${formatOrgRoleLabel(report.role)} (${report.name})`),
    };
  }

  async function computeDelegationDepth(agent: typeof agents.$inferSelect): Promise<number> {
    if (agent.kind === "spawned") return 0;

    let depth = 0;
    let currentReportsTo = agent.reportsTo;
    const seen = new Set<string>();

    while (currentReportsTo && depth < 10) {
      if (seen.has(currentReportsTo)) break;
      seen.add(currentReportsTo);
      const parent = await db
        .select({ reportsTo: agents.reportsTo })
        .from(agents)
        .where(eq(agents.id, currentReportsTo))
        .then((rows) => rows[0] ?? null);
      depth += 1;
      currentReportsTo = parent?.reportsTo ?? null;
    }

    return depth;
  }

  async function resolveDelegationRunContext(input: {
    agent: typeof agents.$inferSelect;
    wakeReason: string | null;
    wakeupRequestId: string | null;
  }): Promise<{ delegatorAgentId: string | null; delegationStyle: DelegationStyle | undefined }> {
    const { agent, wakeReason, wakeupRequestId } = input;

    let delegatorAgentId = agent.kind === "spawned" ? agent.spawnedByAgentId ?? null : null;

    if (!delegatorAgentId && wakeReason === "issue_assigned" && wakeupRequestId) {
      const wakeupRequest = await db
        .select({
          requestedByActorType: agentWakeupRequests.requestedByActorType,
          requestedByActorId: agentWakeupRequests.requestedByActorId,
        })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null);

      if (wakeupRequest?.requestedByActorType === "agent" && wakeupRequest.requestedByActorId) {
        delegatorAgentId = wakeupRequest.requestedByActorId;
      }
    }

    if (!delegatorAgentId) {
      return { delegatorAgentId: null, delegationStyle: undefined };
    }

    const delegator = await db
      .select({
        id: agents.id,
        companyId: agents.companyId,
        delegationStyle: agents.delegationStyle,
      })
      .from(agents)
      .where(eq(agents.id, delegatorAgentId))
      .then((rows) => rows[0] ?? null);

    if (!delegator || delegator.companyId !== agent.companyId) {
      return { delegatorAgentId: null, delegationStyle: undefined };
    }

    return {
      delegatorAgentId: delegator.id,
      delegationStyle: delegator.delegationStyle,
    };
  }

  return {
    resolveOrgPosition,
    computeDelegationDepth,
    resolveDelegationRunContext,
  };
}
