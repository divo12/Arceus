/**
 * @module skills.routes
 * Routes for the skill registry — CRUD, mutations, ATA pipeline, pattern learning, and cross-sprint promotion.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getActiveCompanyId } from "../persistence/active-company.js";
import {
  getAllSkills, getSkillHealth, getSkillHistory as registryGetSkillHistory,
  seedExistingSkills, getMutationsForCompany, getAttributionsForCompany,
  processTaskOutcome, runATAPipeline, getMutationById,
  getPatternsForCompany, clusterPatterns, checkSkillCandidates,
  proposeSkillFromCluster, getPatternCount, extractPattern,
  matchSkills as registryMatchSkills, recordSkillUsage,
  getUnusedSkills, getUnderperformingSkills, analyzeSprintPatterns,
} from "@arceus/company-runtime";
import { runCrossSprintTransfer } from "../skills/cross-sprint.js";
import { buildSnapshotView } from "../orchestration/snapshot-view.js";
import { swallowAndAudit } from "../observability/swallow.js";
import { parseOptionalInt } from "./_helpers.js";

export default async function skillsRoutes(app: FastifyInstance) {
  app.get("/api/skills", async () => {
    const companyId = getActiveCompanyId();
    if (companyId && getAllSkills(companyId).length === 0) {
      seedExistingSkills(companyId);
    }
    const skills = companyId ? getAllSkills(companyId) : [];
    return {
      skills: skills.map((s) => ({
        id: s.id,
        name: s.name,
        role: s.role,
        version: s.version,
        status: s.status,
        trigger: s.trigger,
        successRate: s.successRate,
        usageCount: s.usageCount,
        lastUsedAt: s.lastUsedAt,
        createdAt: s.createdAt,
      })),
      total: skills.length,
    };
  });

  app.get("/api/skills/health", async () => {
    const companyId = getActiveCompanyId() ?? "";
    if (companyId && companyId !== "company_empty") {
      seedExistingSkills(companyId);
    }
    return getSkillHealth(companyId);
  });

  app.get("/api/skills/:name/history", async (request) => {
    const { name } = request.params as { name: string };
    const companyId = getActiveCompanyId() ?? "";
    if (companyId && companyId !== "company_empty") {
      seedExistingSkills(companyId);
    }
    const history = registryGetSkillHistory(companyId, name);
    return { name, versions: history };
  });

  app.get("/api/skills/mutations", async () => {
    const companyId = getActiveCompanyId() ?? "";
    const mutations = getMutationsForCompany(companyId);
    return {
      mutations: mutations.map((m) => ({
        id: m.id,
        originalSkillId: m.originalSkillId,
        proposedSkillName: m.proposedSkill.name,
        proposedSkillVersion: m.proposedSkill.version,
        reason: m.reason,
        status: m.status,
        revisionCycle: m.revisionCycle,
        proposedBy: m.proposedBy,
        proposedAt: m.proposedAt,
        resolvedAt: m.resolvedAt,
      })),
      total: mutations.length,
    };
  });

  app.get("/api/skills/mutations/:id", async (request) => {
    const { id } = request.params as { id: string };
    const mutation = getMutationById(id);
    if (!mutation) return { error: "not found" };
    return { mutation };
  });

  app.get("/api/skills/attributions", async () => {
    const companyId = getActiveCompanyId() ?? "";
    return {
      attributions: getAttributionsForCompany(companyId),
    };
  });

  // Audit C12 (F-426): Zod parse for the simulate-task-outcome body.
  const simulateTaskOutcomeBody = z.object({
    taskId: z.string().min(1),
    taskTitle: z.string().min(1),
    taskDescription: z.string(),
    assignedRole: z.enum(["ceo", "cto", "pm", "developer", "tester", "ui_designer", "marketing", "skills_lead"]),
    status: z.enum(["completed", "failed"]),
    iterationCount: z.number().int().nonnegative(),
    executionTrace: z.string().optional(),
    sprintId: z.string().optional(),
  });

  app.post("/api/skills/simulate-task-outcome", async (request, reply) => {
    const parsed = simulateTaskOutcomeBody.safeParse(request.body);
    if (!parsed.success) {
      reply.code(422);
      return { error: "Invalid simulate-task-outcome payload.", details: parsed.error.issues };
    }
    const body = parsed.data;
    const companyId = getActiveCompanyId() ?? "";
    if (companyId && companyId !== "company_empty") {
      seedExistingSkills(companyId);
    }

    const preMatchedSkills = registryMatchSkills(
      companyId,
      body.assignedRole,
      `${body.taskTitle} ${body.taskDescription}`,
    );
    for (const skill of preMatchedSkills) {
      recordSkillUsage(skill.id);
    }

    const mutation = await processTaskOutcome({
      ...body,
      companyId,
    });

    const patternOutcome = body.status === "failed"
      ? "failure" as const
      : body.iterationCount > 1
        ? "high_friction" as const
        : "success" as const;
    const activeSkillIds = preMatchedSkills.map((s) => s.id);
    const pattern = await extractPattern({
      taskId: body.taskId,
      taskTitle: body.taskTitle,
      taskDescription: body.taskDescription,
      assignedRole: body.assignedRole,
      companyId,
      outcome: patternOutcome,
      trajectory: body.executionTrace,
      activeSkillIds,
      sprintId: body.sprintId,
    });

    return {
      mutationProposed: mutation !== null,
      mutation: mutation ? {
        id: mutation.id,
        status: mutation.status,
        reason: mutation.reason,
        originalSkillId: mutation.originalSkillId,
        proposedSkillName: mutation.proposedSkill.name,
        proposedSkillVersion: mutation.proposedSkill.version,
        proposedSkillContentPreview: mutation.proposedSkill.content.slice(0, 200),
      } : null,
      pattern: {
        id: pattern.id,
        outcome: pattern.outcome,
        usageCount: pattern.usageCount,
        successRate: pattern.successRate,
        embeddingDim: pattern.embedding.length,
      },
    };
  });

  app.post("/api/skills/mutations/:id/run-ata", async (request) => {
    const { id } = request.params as { id: string };
    const mutation = getMutationById(id);
    if (!mutation) {
      return { error: `Mutation ${id} not found` };
    }
    if (mutation.status !== "proposed" && mutation.status !== "revision") {
      return { error: `Mutation ${id} has status "${mutation.status}", expected "proposed" or "revision"` };
    }
    const result = await runATAPipeline(id);
    return {
      verdict: result.verdict,
      revisionCycles: result.revisionCycles,
      completedAt: result.completedAt,
      reviewVerdict: result.reviewVerdict,
      testScenarios: result.testScenarios,
      dryRunResults: result.dryRunResults,
    };
  });

  // ── Pattern Learning ──

  app.get("/api/patterns", async () => {
    const companyId = getActiveCompanyId() ?? "";
    const patterns = getPatternsForCompany(companyId);
    return {
      companyId,
      totalPatterns: patterns.length,
      globalCount: getPatternCount(),
      patterns: patterns.map((p) => ({
        id: p.id,
        role: p.role,
        taskTitle: p.taskTitle,
        summary: p.summary,
        outcome: p.outcome,
        usageCount: p.usageCount,
        successRate: p.successRate,
        sourceTaskIds: p.sourceTaskIds,
        matchedSkillIds: p.matchedSkillIds,
        tags: p.tags,
        sprintIds: p.sprintIds ?? [],
        firstSeenSprintId: p.firstSeenSprintId ?? null,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      })),
    };
  });

  app.get("/api/patterns/clusters", async () => {
    const companyId = getActiveCompanyId() ?? "";
    return {
      companyId,
      clusters: clusterPatterns(companyId),
    };
  });

  app.get("/api/patterns/candidates", async () => {
    const companyId = getActiveCompanyId() ?? "";
    return {
      companyId,
      candidates: checkSkillCandidates(companyId),
    };
  });

  app.post("/api/patterns/promote/:clusterId", async (request) => {
    const { clusterId } = request.params as { clusterId: string };
    const companyId = getActiveCompanyId() ?? "";
    const candidate = checkSkillCandidates(companyId).find((c) => c.clusterId === clusterId);
    if (!candidate) {
      return {
        error: `No promotable candidate for cluster ${clusterId}. It may be below threshold or already covered by an active skill.`,
      };
    }
    const mutation = await proposeSkillFromCluster(candidate);
    swallowAndAudit("ata.pipeline.cluster_promote", () => runATAPipeline(mutation.id), {
      companyId,
      agentRole: "skills_lead",
      detail: { mutationId: mutation.id, clusterId },
    });
    return {
      mutationId: mutation.id,
      proposedSkillId: mutation.proposedSkill.id,
      proposedSkillName: mutation.proposedSkill.name,
      status: mutation.status,
    };
  });

  app.post("/api/patterns/sweep", async () => {
    const companyId = getActiveCompanyId() ?? "";
    if (!companyId) {
      return { companyId, candidatesFound: 0, mutationsProposed: 0, mutationsRefused: 0, reason: "no active company" };
    }
    // Migrated off the deprecated all-time sweep — Spec 14 Phase 6
    // promotes patterns within the current sprint's window only.
    const snapshot = await buildSnapshotView(companyId);
    const sprintId = snapshot.company.currentSprintId;
    if (!sprintId) {
      return { companyId, candidatesFound: 0, mutationsProposed: 0, mutationsRefused: 0, reason: "no active sprint" };
    }
    const result = await runCrossSprintTransfer(companyId, sprintId);
    return { companyId, sprintId, ...result };
  });

  // ── Unused / underperforming skills ──

  app.get("/api/skills/unused", async () => {
    const companyId = getActiveCompanyId() ?? "";
    if (companyId && companyId !== "company_empty") {
      seedExistingSkills(companyId);
    }
    const staleDays = 30;
    return {
      staleDays,
      skills: getUnusedSkills(companyId, staleDays),
    };
  });

  app.get("/api/skills/underperforming", async (request) => {
    const companyId = getActiveCompanyId() ?? "";
    if (companyId && companyId !== "company_empty") {
      seedExistingSkills(companyId);
    }
    const query = request.query as { threshold?: string };
    const threshold = query.threshold ? Number.parseFloat(query.threshold) : 0.6;
    return {
      threshold,
      skills: getUnderperformingSkills(companyId, threshold),
    };
  });

  app.get("/api/skills/sprint-candidates/:sprintId", async (request) => {
    const companyId = getActiveCompanyId() ?? "";
    const { sprintId } = request.params as { sprintId: string };
    const query = request.query as { minFrequency?: string };
    // Audit C13 (F-434): NaN-safe parse with reasonable bounds. minFrequency is a clustering
    // threshold — any positive int <= 50 is sensible.
    const minFrequency = parseOptionalInt(query.minFrequency, { min: 1, max: 50 }) ?? 3;
    return {
      sprintId,
      minFrequency,
      candidates: analyzeSprintPatterns(companyId, sprintId, minFrequency),
    };
  });
}
