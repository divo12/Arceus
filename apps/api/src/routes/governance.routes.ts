import type { FastifyInstance } from "fastify";
import { getSnapshot } from "../persistence/store.js";
import { cpGetAllTrustScores, cpLoadTrustScore, cpUpdateTrustScore, cpGetPolicyViolations, cpHydrateTrustScores } from "../persistence/control-plane.js";
import { BASE_POLICY_RULES, buildTrustEvent, getTrustTier } from "@arceus/company-runtime";
import { getDb, isDatabaseConfigured, trustScoresTable } from "@arceus/db";
import { inArray } from "drizzle-orm";
import { getSprintBudget, getAllSprintBudgets, SPRINT_EVOLUTION_BUDGET_CENTS, MAX_MUTATIONS_PER_SPRINT, MIN_TRUST_FOR_MUTATION, canProposeMutation, lintSkillContent, recordMutationProposal } from "../skills/governance.js";

export default async function governanceRoutes(app: FastifyInstance) {
  app.get("/api/governance/trust-scores", async () => {
    const scores = cpGetAllTrustScores();
    const agents = getSnapshot().agents;
    const agentById = new Map(agents.map((a) => [a.id, a]));
    const roleFromId = (id: string): string | null => {
      const m = id.match(/^agent_(.+?)_[0-9a-f-]{36}$/);
      return m ? m[1] : null;
    };
    return scores.map((s) => {
      const agent = agentById.get(s.agentId);
      return {
        ...s,
        agentRole: agent?.role ?? roleFromId(s.agentId),
        agentName: agent?.name ?? null,
        tier: getTrustTier(s.score),
      };
    });
  });

  app.get("/api/governance/trust-scores/:agentId", async (request) => {
    const { agentId } = request.params as { agentId: string };
    const score = await cpLoadTrustScore(agentId);
    return { ...score, tier: getTrustTier(score.score) };
  });

  app.post("/api/governance/trust-scores/:agentId/adjust", async (request) => {
    const { agentId } = request.params as { agentId: string };
    const body = request.body as { kind: string; reason: string; delta?: number };
    if (!body.kind || !body.reason) return { error: "kind and reason are required" };
    const event = buildTrustEvent(
      agentId,
      body.kind as any,
      `Manual: ${body.reason}`,
      new Date().toISOString(),
      body.delta,
    );
    const updated = await cpUpdateTrustScore(event);
    return { ...updated, tier: getTrustTier(updated.score) };
  });

  app.post("/api/governance/trust-scores/cleanup", async () => {
    if (!isDatabaseConfigured()) {
      return { deletedCount: 0, reason: "database not configured" };
    }
    const liveAgentIds = new Set(getSnapshot().agents.map((a) => a.id));
    const db = getDb();
    const rows = await db.select({ agentId: trustScoresTable.agentId }).from(trustScoresTable);
    const orphanIds = rows.map((r) => r.agentId).filter((id) => !liveAgentIds.has(id));
    if (orphanIds.length === 0) return { deletedCount: 0 };
    await db.delete(trustScoresTable).where(inArray(trustScoresTable.agentId, orphanIds));
    return { deletedCount: orphanIds.length };
  });

  app.get("/api/governance/violations", async (request) => {
    const query = request.query as { agentId?: string; limit?: string };
    return cpGetPolicyViolations({
      agentId: query.agentId,
      limit: query.limit ? parseInt(query.limit, 10) : undefined,
    });
  });

  app.get("/api/governance/policies", async () => {
    return BASE_POLICY_RULES.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      priority: r.priority,
      appliesTo: r.appliesTo,
      toolPatterns: r.toolPatterns,
      minTrust: r.minTrust,
      decision: r.decision,
    }));
  });

  app.get("/api/governance/stats", async () => {
    const scores = cpGetAllTrustScores();
    const violations = await cpGetPolicyViolations({ limit: 200 });
    const snap = getSnapshot();
    const agents = snap.agents ?? [];
    return {
      agentCount: agents.length,
      trustScoreCount: scores.length,
      averageTrust: scores.length > 0 ? scores.reduce((s, t) => s + t.score, 0) / scores.length : 0,
      tierDistribution: {
        autonomous: scores.filter((s) => getTrustTier(s.score) === "autonomous").length,
        trusted: scores.filter((s) => getTrustTier(s.score) === "trusted").length,
        standard: scores.filter((s) => getTrustTier(s.score) === "standard").length,
        restricted: scores.filter((s) => getTrustTier(s.score) === "restricted").length,
        critical: scores.filter((s) => getTrustTier(s.score) === "critical").length,
      },
      recentViolations: violations.length,
      violationsBySeverity: {
        low: violations.filter((v) => v.severity === "low").length,
        medium: violations.filter((v) => v.severity === "medium").length,
        high: violations.filter((v) => v.severity === "high").length,
        critical: violations.filter((v) => v.severity === "critical").length,
      },
      policyCount: BASE_POLICY_RULES.length,
    };
  });

  app.get("/api/governance/sprint-budget/:sprintId", async (request) => {
    const { sprintId } = request.params as { sprintId: string };
    const budget = getSprintBudget(sprintId);
    return {
      sprintId,
      mutationCount: budget.mutationCount,
      mutationCap: MAX_MUTATIONS_PER_SPRINT,
      budgetCentsSpent: budget.budgetCentsSpent,
      budgetCentsRemaining: SPRINT_EVOLUTION_BUDGET_CENTS - budget.budgetCentsSpent,
      budgetCeilingCents: SPRINT_EVOLUTION_BUDGET_CENTS,
      proposals: budget.proposals,
    };
  });

  app.get("/api/governance/budgets", async () => {
    for (const sprint of getSnapshot().sprints) {
      getSprintBudget(sprint.id);
    }
    return {
      mutationCap: MAX_MUTATIONS_PER_SPRINT,
      budgetCeilingCents: SPRINT_EVOLUTION_BUDGET_CENTS,
      minTrustForMutation: MIN_TRUST_FOR_MUTATION,
      sprints: getAllSprintBudgets(),
    };
  });

  app.post("/api/governance/check", async (request) => {
    const body = request.body as {
      proposerAgentId: string | null;
      proposerRole: string;
      targetSkillRole: string;
      sprintId: string;
      skillContent: string;
      estimatedCostCents?: number;
    };
    const companyId = getSnapshot().company.id;
    const decision = await canProposeMutation({
      proposerAgentId: body.proposerAgentId,
      proposerRole: body.proposerRole as any,
      targetSkillRole: body.targetSkillRole,
      companyId,
      sprintId: body.sprintId ?? null,
      skillContent: body.skillContent,
      estimatedCostCents: body.estimatedCostCents ?? 1,
    });
    const lint = lintSkillContent(body.skillContent);
    if (decision.allowed) {
      recordMutationProposal({
        companyId,
        sprintId: body.sprintId ?? null,
        mutationId: `gov-check-${Date.now()}`,
        proposedBy: body.proposerAgentId ?? body.proposerRole,
        costCents: body.estimatedCostCents ?? 1,
      });
    }
    return { allowed: decision.allowed, code: (decision as { code?: string }).code ?? null, reason: (decision as { reason?: string }).reason ?? null, lintIssues: lint.findings };
  });
}
