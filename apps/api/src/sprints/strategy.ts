/**
 * Strategy application — Spec 31 Phase 7.C.c-bis.
 *
 * Atomic, transactional creation of the org chart from a CEO strategy
 * proposal. The previous implementation in `persistence/store.ts`
 * mutated the in-memory snapshot first and then fired five separate
 * fire-and-forget canonical writes (company-update, hierarchy, agents,
 * memories, strategy). A partial failure left the company half-built:
 * agents in the DB but no hierarchy, or hierarchy but no memories.
 *
 * This module wraps every write touched by `applyStrategy` in a single
 * `db.transaction()`. Either the entire org chart commits or nothing
 * does. Each repo stays single-table — the compound workflow is here.
 */
import type {
  AgentIdentity,
  Company,
  FundamentalIdea,
  HierarchyNode,
  MemorySummary,
  StrategyBrief,
} from "@arceus/contracts";
import {
  ROLE_DEPLOYMENT_MODEL,
  ROLE_DISPLAY_NAMES,
  ROLE_INITIAL_AGENT_STATUS,
  assertRoleHierarchy,
  getRoleSoul,
} from "@arceus/company-runtime";
import { getDb } from "@arceus/db";
import * as agentsRepo from "@arceus/db/src/repos/agents.js";
import * as companiesRepo from "@arceus/db/src/repos/companies.js";
import * as hierarchyNodesRepo from "@arceus/db/src/repos/hierarchy_nodes.js";
import * as ideasRepo from "@arceus/db/src/repos/ideas.js";
import * as memorySummariesRepo from "@arceus/db/src/repos/memory_summaries.js";
import * as strategyBriefsRepo from "@arceus/db/src/repos/strategy_briefs.js";
import type { StrategyOutput } from "../agents/ceo.js";

interface ApplyStrategyResult {
  company: Company;
  idea: FundamentalIdea;
  strategy: StrategyBrief;
  hierarchy: HierarchyNode[];
  agents: AgentIdentity[];
  memories: MemorySummary[];
}

function titleCase(value: string) {
  return value
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function buildAgentName(role: string) {
  return (ROLE_DISPLAY_NAMES as Record<string, string | undefined>)[role]
    ?? titleCase(role.replace(/_/g, " "));
}

/**
 * Apply a CEO strategy to an existing company. Reads the current
 * company / idea / strategy rows and writes the new hierarchy +
 * agents + memories + updated strategy / idea / company status in a
 * single transaction.
 */
export async function applyStrategyTx(
  companyId: string,
  output: StrategyOutput,
): Promise<ApplyStrategyResult> {
  if (output.roles.some((r) => r.role === "developer") && !output.roles.some((r) => r.role === "senior_developer")) {
    const ctoRole = output.roles.find((r) => r.role === "cto");
    output.roles.push({ role: "senior_developer", title: "Senior Developer", parent_role: ctoRole?.role ?? "cto", capabilities: ["Code review", "Architecture hygiene"] });
  }
  assertRoleHierarchy(output.roles);

  const db = getDb();

  // Read the current rows we need to update. findActiveByCompany returns
  // the raw row (Date timestamps); hydrate via rowToStrategy so we work in
  // contract types (ISO strings) end-to-end.
  const [currentCompany, currentIdea, strategyRow] = await Promise.all([
    companiesRepo.findByIdHydrated(db, companyId),
    ideasRepo.findByCompanyHydrated(db, companyId),
    strategyBriefsRepo.findActiveByCompany(db, companyId),
  ]);
  if (!currentCompany) throw new Error(`applyStrategyTx: company ${companyId} not found`);
  if (!currentIdea) throw new Error(`applyStrategyTx: idea for company ${companyId} not found`);
  if (!strategyRow) throw new Error(`applyStrategyTx: strategy for company ${companyId} not found`);
  const currentStrategy = strategyBriefsRepo.rowToStrategy(strategyRow);

  // ── Build the org chart in memory ────────────────────────────
  const roleToAgentId = new Map<string, string>();
  const hierarchy: HierarchyNode[] = output.roles.map((role) => {
    const nodeId = `node_${crypto.randomUUID()}`;
    const agentId = `agent_${role.role}_${crypto.randomUUID()}`;
    roleToAgentId.set(role.role, agentId);
    return {
      id: nodeId,
      role: role.role,
      title: role.title,
      level: 0,
      parentNodeId: null,
      agentId,
      directReportNodeIds: [],
      openForHiring: false,
    };
  });

  const nodeByRole = new Map(hierarchy.map((node) => [node.role, node]));
  for (const role of output.roles) {
    const node = nodeByRole.get(role.role);
    if (!node || !role.parent_role) continue;
    const parent = nodeByRole.get(role.parent_role);
    node.parentNodeId = parent?.id ?? null;
    if (parent) parent.directReportNodeIds.push(node.id);
  }

  const levelCache = new Map<HierarchyNode["role"], number>();
  const computeLevel = (node: HierarchyNode): number => {
    const cached = levelCache.get(node.role);
    if (cached !== undefined) return cached;
    if (!node.parentNodeId) {
      levelCache.set(node.role, 0);
      return 0;
    }
    const parent = hierarchy.find((c) => c.id === node.parentNodeId);
    const level = parent ? computeLevel(parent) + 1 : 0;
    levelCache.set(node.role, level);
    return level;
  };
  hierarchy.forEach((n) => { n.level = computeLevel(n); });

  const agents: AgentIdentity[] = output.roles.map((role) => {
    const node = nodeByRole.get(role.role)!;
    const managerAgentId = role.parent_role
      ? roleToAgentId.get(role.parent_role) ?? null
      : null;
    const reportAgentIds = output.roles
      .filter((c) => c.parent_role === role.role)
      .map((c) => roleToAgentId.get(c.role) ?? "")
      .filter(Boolean);
    return {
      id: node.agentId!,
      companyId,
      nodeId: node.id,
      name: buildAgentName(role.role),
      role: role.role,
      title: role.title,
      managerAgentId,
      reportAgentIds,
      capabilities: role.capabilities,
      profile: `${role.title} for ${currentCompany.name}`,
      soul: getRoleSoul(role.role),
      status: ROLE_INITIAL_AGENT_STATUS[role.role] ?? "active",
      sessionBindingId: `session_${crypto.randomUUID()}`,
      memorySummaryId: `memory_${crypto.randomUUID()}`,
      lastHeartbeatAt: null,
    };
  });

  const memories: MemorySummary[] = agents.map((agent) => ({
    id: agent.memorySummaryId,
    agentId: agent.id,
    currentFocus: [],
    recentLearnings: [],
    activePatterns: [],
    openBlockers: [],
    importantDecisions: [],
    updatedAt: new Date().toISOString(),
  }));

  const updatedCompany: Company = { ...currentCompany, status: "active" };
  const updatedIdea: FundamentalIdea = {
    ...currentIdea,
    currentDirection: output.first_release,
    refinedWithBoard: true,
  };
  const updatedStrategy: StrategyBrief = {
    ...currentStrategy,
    title: output.strategy_title,
    summary: output.summary,
    firstRelease: output.first_release,
    scopeBoundary: output.scope_boundary,
    roleRationale: output.role_rationale,
    status: "pending_board_approval",
  };

  // ── Atomic write ────────────────────────────────────────────
  // Order matters: hierarchy_nodes.agent_id and memory_summaries.agent_id
  // are FKs to agents.id, so agents must land before either of them.
  await db.transaction(async (tx) => {
    await companiesRepo.upsertCompany(tx, updatedCompany);
    await ideasRepo.upsertIdea(tx, updatedIdea);
    await strategyBriefsRepo.upsertStrategy(tx, updatedStrategy);
    for (const agent of agents) {
      await agentsRepo.upsertAgent(tx, agent);
    }
    await hierarchyNodesRepo.replaceForCompany(tx, companyId, hierarchy);
    for (const memory of memories) {
      await memorySummariesRepo.upsertSummary(tx, memory, companyId);
    }
  });

  // Spec 31 Phase 7.C.d-cp — initialize trust scores for the freshly
  // hired roster. Replaces the storeEvents `agents-hired` listener.
  // Fire-and-forget so the route response doesn't wait on per-agent
  // governance rows; cpInitializeAgentTrust logs failures internally.
  void (await import("../persistence/control-plane/index.js")).cpInitializeAgentTrust(agents);

  return {
    company: updatedCompany,
    idea: updatedIdea,
    strategy: updatedStrategy,
    hierarchy,
    agents,
    memories,
  };
}

/**
 * Used by callers (e.g. event log writers) that need the
 * `strategy.proposed` event after applyStrategyTx commits. Pure helper
 * — no side effects.
 */
