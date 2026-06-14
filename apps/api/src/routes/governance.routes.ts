/**
 * @module governance.routes
 * Routes for governance — trust scores, policy violations, sprint budgets, and mutation checks.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireUserAuth } from "../auth/user-jwt-middleware.js";

/** Prefer JWT-derived companyId; fall back to singleton for legacy paths. */
function resolveCompanyId(request: FastifyRequest): string | null {
  return request.companyId;
}
import { cpGetAllTrustScores, cpLoadTrustScore, cpUpdateTrustScore, cpGetPolicyViolations, cpHydrateTrustScores } from "../persistence/control-plane/index.js";
import { BASE_POLICY_RULES, buildTrustEvent, getTrustTier } from "@arceus/company-runtime";
import { getDb, isDatabaseConfigured, trustScoresTable } from "@arceus/db";
import * as agentsRepo from "@arceus/db/src/repos/agents.js";
import * as sprintsRepo from "@arceus/db/src/repos/sprints.js";
import { inArray } from "drizzle-orm";
import { getSprintBudget, getAllSprintBudgets, SPRINT_EVOLUTION_BUDGET_CENTS, MAX_MUTATIONS_PER_SPRINT, MIN_TRUST_FOR_MUTATION, canProposeMutation, lintSkillContent, recordMutationProposal } from "../skills/governance.js";
import { parseOptionalInt, HARD_LIST_CAP } from "./_helpers.js";

export default async function governanceRoutes(app: FastifyInstance) {
  app.get("/api/governance/trust-scores", { preHandler: [requireUserAuth] }, async (request) => {
    const scores = cpGetAllTrustScores();
    const companyId = resolveCompanyId(request);
    const agents = companyId ? await agentsRepo.listAgentsByCompany(getDb(), companyId) : [];
    const agentById = new Map(agents.map((a) => [a.id, a]));
    const roleFromId = (id: string): string | null => {
      const m = /^agent_(.+?)_[0-9a-f-]{36}$/.exec(id);
      return m ? m[1] : null;
    };
    return scores.map((s) => {
      const agent = agentById.get(s.agentId);
      return {
        ...s,
        agentRole: agent?.role ?? roleFromId(s.agentId),
        agentName: agent?.displayName ?? null,
        tier: getTrustTier(s.score),
      };
    });
  });

  app.get("/api/governance/trust-scores/:agentId", { preHandler: [requireUserAuth] }, async (request) => {
    const { agentId } = request.params as { agentId: string };
    const score = await cpLoadTrustScore(agentId);
    return { ...score, tier: getTrustTier(score.score) };
  });

  // Audit C12 (F-426/F-433): Zod-validate the body at the boundary.
  // Replaces `request.body as { ... }` + `body.kind as any` — typos
  // / wrong enums now reject with 422 instead of being smuggled into
  // buildTrustEvent.
  const adjustTrustBody = z.object({
    kind: z.enum(["task_completed", "task_failed", "violation", "escalation_resolved", "manual_adjustment"]),
    reason: z.string().min(1).max(500),
    delta: z.number().optional(),
  });
  const adjustParams = z.object({ agentId: z.string().min(1) });

  app.post("/api/governance/trust-scores/:agentId/adjust", { preHandler: [requireUserAuth] }, async (request, reply) => {
    const params = adjustParams.safeParse(request.params);
    const body = adjustTrustBody.safeParse(request.body);
    if (!params.success || !body.success) {
      reply.code(422);
      return { error: "Invalid trust adjustment payload.", details: !params.success ? params.error.issues : body.success ? null : body.error.issues };
    }
    const event = buildTrustEvent(
      params.data.agentId,
      body.data.kind,
      `Manual: ${body.data.reason}`,
      new Date().toISOString(),
      body.data.delta,
    );
    const updated = await cpUpdateTrustScore(event);
    return { ...updated, tier: getTrustTier(updated.score) };
  });

  app.post("/api/governance/trust-scores/cleanup", { preHandler: [requireUserAuth] }, async (request) => {
    if (!isDatabaseConfigured()) {
      return { deletedCount: 0, reason: "database not configured" };
    }
    const companyId = resolveCompanyId(request);
    const liveAgents = companyId ? await agentsRepo.listAgentsByCompany(getDb(), companyId) : [];
    const liveAgentIds = new Set(liveAgents.map((a) => a.id));
    const db = getDb();
    const rows = await db.select({ agentId: trustScoresTable.agentId }).from(trustScoresTable);
    const orphanIds = rows.map((r) => r.agentId).filter((id) => !liveAgentIds.has(id));
    if (orphanIds.length === 0) return { deletedCount: 0 };
    await db.delete(trustScoresTable).where(inArray(trustScoresTable.agentId, orphanIds));
    return { deletedCount: orphanIds.length };
  });

  app.get("/api/governance/violations", { preHandler: [requireUserAuth] }, async (request) => {
    const query = request.query as { agentId?: string; limit?: string };
    return cpGetPolicyViolations({
      agentId: query.agentId,
      // Audit C13 (F-434): NaN-safe optional limit. `parseInt(garbage)` was returning NaN
      // which silently became "no limit" downstream. Now: undefined on missing/invalid,
      // capped at HARD_LIST_CAP otherwise.
      limit: parseOptionalInt(query.limit, { min: 1, max: HARD_LIST_CAP }),
    });
  });

  app.get("/api/governance/policies", { preHandler: [requireUserAuth] }, async () => {
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

  app.get("/api/governance/stats", { preHandler: [requireUserAuth] }, async (request) => {
    const scores = cpGetAllTrustScores();
    const violations = await cpGetPolicyViolations({ limit: 200 });
    const companyId = resolveCompanyId(request);
    const agents = companyId ? await agentsRepo.listAgentsByCompany(getDb(), companyId) : [];
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

  app.get("/api/governance/sprint-budget/:sprintId", { preHandler: [requireUserAuth] }, async (request) => {
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

  app.get("/api/governance/budgets", { preHandler: [requireUserAuth] }, async (request) => {
    const companyId = resolveCompanyId(request);
    if (companyId) {
      const sprints = await sprintsRepo.listSprintsByCompany(getDb(), companyId);
      for (const sprint of sprints) {
        getSprintBudget(sprint.id);
      }
    }
    return {
      mutationCap: MAX_MUTATIONS_PER_SPRINT,
      budgetCeilingCents: SPRINT_EVOLUTION_BUDGET_CENTS,
      minTrustForMutation: MIN_TRUST_FOR_MUTATION,
      sprints: getAllSprintBudgets(),
    };
  });

  // Audit C12 (F-426): Zod-validate the body. proposerRole now narrows
  // to the agent role enum at parse time, eliminating the `as` cast
  // into canProposeMutation.
  const governanceCheckBody = z.object({
    proposerAgentId: z.string().nullable(),
    proposerRole: z.enum(["ceo", "cto", "pm", "developer", "tester", "ui_designer", "marketing", "skills_lead"]),
    targetSkillRole: z.string().min(1),
    sprintId: z.string().nullable().optional(),
    skillContent: z.string().min(1),
    estimatedCostCents: z.number().nonnegative().optional(),
  });

  app.post("/api/governance/check", { preHandler: [requireUserAuth] }, async (request, reply) => {
    const parsed = governanceCheckBody.safeParse(request.body);
    if (!parsed.success) {
      reply.code(422);
      return { error: "Invalid governance check payload.", details: parsed.error.issues };
    }
    const body = parsed.data;
    const companyId = resolveCompanyId(request) ?? "";
    const decision = await canProposeMutation({
      proposerAgentId: body.proposerAgentId,
      proposerRole: body.proposerRole,
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
