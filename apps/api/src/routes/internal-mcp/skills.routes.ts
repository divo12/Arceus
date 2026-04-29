/**
 * Spec 29 Phase B + C — Skills-Lead MCP tool routes.
 *
 * Read-only (Phase B): SL + CEO
 *   POST /skills/health-report
 *   POST /skills/audit-unused
 *   POST /skills/inspect-history
 *   POST /skills/validate-definition
 *
 * Writes (Phase C): SL only
 *   POST /skills/register
 *   POST /skills/update
 *   POST /skills/deprecate
 *
 * All write paths use `writeRevisionAtomic` (Phase A.3) for fs+git+DB
 * coordination. No LLM in this file.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import {
  getDb,
  isDatabaseConfigured,
  skillArtifacts,
  skillRevisions,
  skillUsageEvents,
} from "@arceus/db";
import {
  registerSkill as registerSkillInMemory,
  deprecateSkill as deprecateSkillInMemory,
  getSkillById as getInMemorySkill,
} from "@arceus/company-runtime";
import { success, failure } from "./envelope.js";
import { cacheSuccessfulResponse } from "./middleware.js";
import { writeRevisionAtomic } from "../../skills/revisions.js";
import { validateSkillDefinition } from "../../skills/validate.js";
import { gitListTagsMatching } from "../../skills/git.js";
import { enqueueJob } from "@arceus/db/src/repos/skill_evolve_jobs.js";
import { swallowAndAudit } from "../../observability/swallow.js";

const SKILLS_BASE = "/api/internal/v1/skills";

const READ_ROLES = new Set(["skills_lead", "ceo"]);
const WRITE_ROLES = new Set(["skills_lead"]);

const enforceRole = (req: FastifyRequest, reply: FastifyReply, allowed: Set<string>): boolean => {
  const role = req.mcp?.role;
  if (!role || !allowed.has(role)) {
    reply
      .code(403)
      .send(failure(`Role "${role ?? "unknown"}" is not allowed to call this tool.`, "governance", "never", "role_authorized"));
    return false;
  }
  return true;
};

const sendValidation = (reply: FastifyReply, err: ZodError): void => {
  reply
    .code(422)
    .send(failure(`Request validation failed: ${err.issues.map((i) => i.message).join("; ")}`, "validation", "never", "payload_fixed"));
};

const requireDb = (reply: FastifyReply): boolean => {
  if (!isDatabaseConfigured()) {
    reply
      .code(503)
      .send(failure("Skill tools require the Drizzle DB to be configured.", "upstream", "never", "db_configured"));
    return false;
  }
  return true;
};

// ── Schemas ──────────────────────────────────────────────────

const healthReportSchema = z.object({
  skillId: z.string().uuid().optional(),
  windowDays: z.number().int().min(1).max(90).default(7),
});

const auditUnusedSchema = z.object({
  staleDays: z.number().int().min(1).max(365).default(30),
  includeRoles: z.array(z.string()).optional(),
});

const inspectHistorySchema = z.object({
  skillId: z.string().uuid(),
  limit: z.number().int().min(1).max(50).default(10),
});

const validateDefinitionSchema = z.object({
  content: z.string().min(1).max(64 * 1024),
  intent: z.enum(["register", "update"]).default("register"),
  skillId: z.string().uuid().optional(),
  slug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,80}$/)
    .optional(),
});

const registerSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,80}$/),
  name: z.string().min(1).max(80),
  role: z.string().min(1).max(40),
  description: z.string().min(1).max(500),
  triggerCondition: z.string().min(1).max(200),
  content: z.string().min(1).max(64 * 1024),
  summary: z.string().min(1).max(280),
});

const updateSchema = z.object({
  skillId: z.string().uuid(),
  content: z.string().min(1).max(64 * 1024),
  summary: z.string().min(1).max(280),
  rollbackFromTag: z.string().max(200).optional(),
});

const deprecateSchema = z.object({
  skillId: z.string().uuid(),
  reason: z.string().min(1).max(500),
  summary: z.string().min(1).max(280),
});

const candidateSubmitSchema = z.object({
  description: z.string().min(8).max(500),
  motivation: z.string().min(8).max(500),
});

// ── Helpers ──────────────────────────────────────────────────

const numericToFloat = (value: unknown): number => {
  if (value == null) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
};

const trendOf = (current: number, baseline: number): "rising" | "flat" | "falling" => {
  if (current > baseline + 0.05) return "rising";
  if (current < baseline - 0.05) return "falling";
  return "flat";
};

// ── Route module ─────────────────────────────────────────────

export default async function internalMcpSkillsRoutes(app: FastifyInstance): Promise<void> {
  // ── B.1 health-report ──────────────────────────────────────
  app.post(`${SKILLS_BASE}/health-report`, async (req, reply) => {
    if (!enforceRole(req, reply, READ_ROLES)) return reply;
    if (!requireDb(reply)) return reply;
    const parsed = healthReportSchema.safeParse(req.body ?? {});
    if (!parsed.success) { sendValidation(reply, parsed.error); return; }

    const mcp = req.mcp!;
    const db = getDb();
    const since = new Date(Date.now() - parsed.data.windowDays * 24 * 3600 * 1000);

    const skillRows = parsed.data.skillId
      ? await db.select().from(skillArtifacts).where(eq(skillArtifacts.id, parsed.data.skillId))
      : await db.select().from(skillArtifacts).where(eq(skillArtifacts.companyId, mcp.companyId));

    if (skillRows.length === 0) {
      const body = success("No matching skills found.", { skills: [] });
      cacheSuccessfulResponse(req, { status: 200, body, locationHeader: null });
      return reply.code(200).send(body);
      return;
    }

    const ids = skillRows.map((s) => s.id);
    const usageRows = (await db.execute(sql`
      SELECT skill_id, COUNT(*)::int AS invocations,
             AVG(outcome_score)::float AS pass_rate
        FROM skill_usage_events
       WHERE skill_id IN ${sql.raw(`(${ids.map((id) => `'${id}'`).join(",")})`)}
         AND occurred_at >= ${since.toISOString()}
       GROUP BY skill_id
    `)) as unknown as { skill_id: string; invocations: number; pass_rate: number | null }[];

    const usage = new Map<string, { invocations: number; passRate: number }>();
    for (const r of usageRows) {
      usage.set(r.skill_id, { invocations: r.invocations, passRate: r.pass_rate ?? 0 });
    }

    const rollbackRows = (await db.execute(sql`
      SELECT skill_id, COUNT(*)::int AS rollback_count
        FROM skill_revisions
       WHERE rollback_from_tag IS NOT NULL
         AND created_at >= ${new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()}
         AND skill_id IN ${sql.raw(`(${ids.map((id) => `'${id}'`).join(",")})`)}
       GROUP BY skill_id
    `)) as unknown as { skill_id: string; rollback_count: number }[];
    const rollback = new Map(rollbackRows.map((r) => [r.skill_id, r.rollback_count]));

    const data = skillRows.map((s) => {
      const u = usage.get(s.id) ?? { invocations: 0, passRate: numericToFloat(s.successRate) };
      const ema = numericToFloat(s.successRate);
      return {
        skillId: s.id,
        slug: s.slug,
        name: s.name,
        status: s.status,
        ema,
        invocations: u.invocations,
        failureRate: Math.max(0, 1 - u.passRate),
        trend: trendOf(u.passRate, ema),
        rollbackCount7d: rollback.get(s.id) ?? 0,
      };
    });

    const body = success(`Health report for ${data.length} skill(s).`, { windowDays: parsed.data.windowDays, skills: data });
    cacheSuccessfulResponse(req, { status: 200, body, locationHeader: null });
    return reply.code(200).send(body);
  });

  // ── B.2 audit-unused ───────────────────────────────────────
  app.post(`${SKILLS_BASE}/audit-unused`, async (req, reply) => {
    if (!enforceRole(req, reply, READ_ROLES)) return reply;
    if (!requireDb(reply)) return reply;
    const parsed = auditUnusedSchema.safeParse(req.body ?? {});
    if (!parsed.success) { sendValidation(reply, parsed.error); return; }

    const mcp = req.mcp!;
    const db = getDb();
    const cutoff = new Date(Date.now() - parsed.data.staleDays * 24 * 3600 * 1000);

    const conds = [eq(skillArtifacts.companyId, mcp.companyId), eq(skillArtifacts.status, "active")];
    if (parsed.data.includeRoles?.length) {
      conds.push(inArray(skillArtifacts.role, parsed.data.includeRoles));
    }
    const candidates = await db.select().from(skillArtifacts).where(and(...conds));

    if (candidates.length === 0) {
      return reply.code(200).send(success("No active skills to audit.", { stale: [] }));
      return;
    }

    const ids = candidates.map((s) => s.id);
    const recentRows = (await db.execute(sql`
      SELECT DISTINCT skill_id FROM skill_usage_events
       WHERE skill_id IN ${sql.raw(`(${ids.map((id) => `'${id}'`).join(",")})`)}
         AND occurred_at >= ${cutoff.toISOString()}
    `)) as unknown as { skill_id: string }[];
    const recentlyUsed = new Set(recentRows.map((r) => r.skill_id));

    const stale = candidates
      .filter((s) => !recentlyUsed.has(s.id))
      .map((s) => ({
        skillId: s.id,
        slug: s.slug,
        name: s.name,
        role: s.role,
        lastUsedAt: s.lastUsedAt?.toISOString() ?? null,
        createdAt: s.createdAt.toISOString(),
      }));

    const body = success(`${stale.length} skill(s) unused in the last ${parsed.data.staleDays} day(s).`, {
      staleDays: parsed.data.staleDays,
      stale,
    });
    cacheSuccessfulResponse(req, { status: 200, body, locationHeader: null });
    return reply.code(200).send(body);
  });

  // ── B.3 inspect-history ────────────────────────────────────
  app.post(`${SKILLS_BASE}/inspect-history`, async (req, reply) => {
    if (!enforceRole(req, reply, READ_ROLES)) return reply;
    if (!requireDb(reply)) return reply;
    const parsed = inspectHistorySchema.safeParse(req.body ?? {});
    if (!parsed.success) { sendValidation(reply, parsed.error); return; }

    const mcp = req.mcp!;
    const db = getDb();
    const skill = await db.select().from(skillArtifacts).where(eq(skillArtifacts.id, parsed.data.skillId)).limit(1);
    if (skill.length === 0 || skill[0].companyId !== mcp.companyId) {
      return reply.code(404).send(failure(`Skill ${parsed.data.skillId} not found.`, "not_found", "never", "skill_exists"));
      return;
    }

    const revisions = await db
      .select()
      .from(skillRevisions)
      .where(eq(skillRevisions.skillId, parsed.data.skillId))
      .orderBy(desc(skillRevisions.revisionNumber))
      .limit(parsed.data.limit);

    let gitTags: string[] = [];
    try {
      gitTags = await gitListTagsMatching({ pattern: `skill-evolve/${skill[0].slug}/*` });
    } catch {
      gitTags = [];
    }
    const tagSet = new Set(gitTags);

    const data = revisions.map((r) => ({
      revisionId: r.id,
      revisionNumber: r.revisionNumber,
      gitTag: r.gitTag,
      gitSha: r.gitSha,
      appliedBy: r.appliedBy,
      proposalId: r.proposalId,
      rollbackFromTag: r.rollbackFromTag,
      summary: r.summary,
      createdAt: r.createdAt.toISOString(),
      gitTagPresent: tagSet.has(r.gitTag),
    }));

    const body = success(`${data.length} revision(s) for ${skill[0].slug}.`, {
      skillId: parsed.data.skillId,
      slug: skill[0].slug,
      revisions: data,
    });
    cacheSuccessfulResponse(req, { status: 200, body, locationHeader: null });
    return reply.code(200).send(body);
  });

  // ── B.4 validate-definition ────────────────────────────────
  app.post(`${SKILLS_BASE}/validate-definition`, async (req, reply) => {
    if (!enforceRole(req, reply, READ_ROLES)) return reply;
    const parsed = validateDefinitionSchema.safeParse(req.body ?? {});
    if (!parsed.success) { sendValidation(reply, parsed.error); return; }

    const mcp = req.mcp!;
    const result = validateSkillDefinition(parsed.data.content);

    let collision: { skillId: string; slug: string } | null = null;
    if (parsed.data.intent === "register" && isDatabaseConfigured()) {
      const slug = parsed.data.slug ?? result.parsed?.frontmatter.name?.toLowerCase().replace(/[^a-z0-9-]+/g, "-") ?? null;
      if (slug) {
        try {
          const existing = await getDb()
            .select({ id: skillArtifacts.id, slug: skillArtifacts.slug })
            .from(skillArtifacts)
            .where(and(eq(skillArtifacts.companyId, mcp.companyId), eq(skillArtifacts.slug, slug)))
            .limit(1);
          if (existing.length > 0) collision = { skillId: existing[0].id, slug: existing[0].slug };
        } catch {
          // DB schema may not be applied (dev) — treat as no-collision-known.
        }
      }
    }
    if (parsed.data.intent === "update" && parsed.data.skillId && isDatabaseConfigured()) {
      try {
        const existing = await getDb()
          .select({ id: skillArtifacts.id })
          .from(skillArtifacts)
          .where(eq(skillArtifacts.id, parsed.data.skillId))
          .limit(1);
        if (existing.length === 0) {
          result.errors.push(`skillId ${parsed.data.skillId} not found for update`);
          result.valid = false;
         
        }
      } catch {
        // DB schema not applied — skip the FK check.
      }
    }

    const body = success(result.valid ? "SKILL.md is valid." : `SKILL.md has ${result.errors.length} error(s).`, {
      valid: result.valid && collision == null,
      errors: collision ? [...result.errors, `slug "${collision.slug}" already registered (id ${collision.skillId})`] : result.errors,
      warnings: result.warnings,
      frontmatter: result.parsed?.frontmatter ?? {},
      collision,
    });
    cacheSuccessfulResponse(req, { status: 200, body, locationHeader: null });
    return reply.code(200).send(body);
  });

  // ── C.1 register ───────────────────────────────────────────
  app.post(`${SKILLS_BASE}/register`, async (req, reply) => {
    if (!enforceRole(req, reply, WRITE_ROLES)) return reply;
    if (!requireDb(reply)) return reply;
    const parsed = registerSchema.safeParse(req.body ?? {});
    if (!parsed.success) { sendValidation(reply, parsed.error); return; }

    const validation = validateSkillDefinition(parsed.data.content);
    if (!validation.valid) {
      return reply.code(422).send(failure(`SKILL.md invalid: ${validation.errors.join("; ")}`, "validation", "never", "payload_fixed"));
      return;
    }

    const mcp = req.mcp!;
    const db = getDb();

    const existing = await db
      .select({ id: skillArtifacts.id })
      .from(skillArtifacts)
      .where(and(eq(skillArtifacts.companyId, mcp.companyId), eq(skillArtifacts.slug, parsed.data.slug)))
      .limit(1);
    if (existing.length > 0) {
      reply
        .code(409)
        .send(failure(`Skill slug "${parsed.data.slug}" already exists in this company.`, "conflict", "never", "slug_unique"));
      return;
    }

    const [artifact] = await db
      .insert(skillArtifacts)
      .values({
        companyId: mcp.companyId,
        slug: parsed.data.slug,
        name: parsed.data.name,
        role: parsed.data.role,
        description: parsed.data.description,
        triggerCondition: parsed.data.triggerCondition,
        content: parsed.data.content,
      })
      .returning();

    let revision: Awaited<ReturnType<typeof writeRevisionAtomic>>;
    try {
      revision = await writeRevisionAtomic({
        skillArtifactId: artifact.id,
        skillSlug: artifact.slug,
        content: parsed.data.content,
        intent: "register",
        appliedBy: `${mcp.role}:${mcp.beatId}`,
        summary: parsed.data.summary,
        // Phase G.3 — record EMA at register time as the rollback baseline.
        emaAtApply: 0.5,
      });
    } catch (err) {
      // roll back the artifact insert too — registration is atomic at the user level
      swallowAndAudit("skill.register.rollback_artifact", () =>
        db.delete(skillArtifacts).where(eq(skillArtifacts.id, artifact.id)).then(() => undefined),
      { agentRole: "skills_lead", detail: { skillId: artifact.id, originalError: err instanceof Error ? err.message : String(err) } });
      reply
        .code(500)
        .send(failure(`Failed to write revision: ${err instanceof Error ? err.message : String(err)}`, "internal", "unsafe", "retry_succeeded"));
      return;
    }

    // mirror to in-memory registry so beat hot-paths see it immediately
    try {
      registerSkillInMemory({
        id: artifact.id,
        companyId: mcp.companyId,
        name: parsed.data.name,
        role: parsed.data.role,
        version: 1,
        status: "active",
        trigger: parsed.data.triggerCondition,
        content: parsed.data.content,
        successRate: 0.5,
        usageCount: 0,
        lastUsedAt: null,
        createdAt: artifact.createdAt.toISOString(),
        approvedAt: artifact.createdAt.toISOString(),
        sourceMutationId: null,
        mutationReason: null,
        resources: [],
      } as any);
    } catch {
      // non-fatal — DB is authoritative
    }

    const body = success(`Registered skill ${artifact.slug} (revision 1).`, {
      skillId: artifact.id,
      slug: artifact.slug,
      revisionId: revision.revisionId,
      revisionNumber: revision.revisionNumber,
      gitTag: revision.gitTag,
      gitSha: revision.gitSha,
    });
    cacheSuccessfulResponse(req, { status: 201, body, locationHeader: `${SKILLS_BASE}/${artifact.id}` });
    reply.code(201).header("location", `${SKILLS_BASE}/${artifact.id}`).send(body);
  });

  // ── C.2 update ─────────────────────────────────────────────
  app.post(`${SKILLS_BASE}/update`, async (req, reply) => {
    if (!enforceRole(req, reply, WRITE_ROLES)) return reply;
    if (!requireDb(reply)) return reply;
    const parsed = updateSchema.safeParse(req.body ?? {});
    if (!parsed.success) { sendValidation(reply, parsed.error); return; }

    const validation = validateSkillDefinition(parsed.data.content);
    if (!validation.valid) {
      return reply.code(422).send(failure(`SKILL.md invalid: ${validation.errors.join("; ")}`, "validation", "never", "payload_fixed"));
      return;
    }

    const mcp = req.mcp!;
    const db = getDb();
    const [artifact] = await db.select().from(skillArtifacts).where(eq(skillArtifacts.id, parsed.data.skillId)).limit(1);
    if (!artifact || artifact.companyId !== mcp.companyId) {
      return reply.code(404).send(failure(`Skill ${parsed.data.skillId} not found.`, "not_found", "never", "skill_exists"));
      return;
    }
    if (artifact.status === "deprecated") {
      return reply.code(409).send(failure(`Skill ${artifact.slug} is deprecated.`, "conflict", "never", "skill_active"));
      return;
    }

    let revision: Awaited<ReturnType<typeof writeRevisionAtomic>>;
    try {
      revision = await writeRevisionAtomic({
        skillArtifactId: artifact.id,
        skillSlug: artifact.slug,
        content: parsed.data.content,
        intent: "update",
        appliedBy: `${mcp.role}:${mcp.beatId}`,
        rollbackFromTag: parsed.data.rollbackFromTag,
        summary: parsed.data.summary,
        // Phase G.3 — record current EMA so the rollback monitor has a baseline.
        emaAtApply: Number(artifact.successRate),
      });
    } catch (err) {
      reply
        .code(500)
        .send(failure(`Failed to write revision: ${err instanceof Error ? err.message : String(err)}`, "internal", "unsafe", "retry_succeeded"));
      return;
    }

    await swallowAndAudit("skill.update.row", () =>
      db.update(skillArtifacts)
        .set({
          content: parsed.data.content,
          version: artifact.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(skillArtifacts.id, artifact.id))
        .then(() => undefined),
    { agentRole: "skills_lead", detail: { skillId: artifact.id, newVersion: artifact.version + 1 } });

    try {
      const inMem = getInMemorySkill(artifact.id);
      if (inMem) {
        registerSkillInMemory({ ...inMem, content: parsed.data.content, version: inMem.version + 1 });
      }
    } catch {
      // non-fatal
    }

    const body = success(`Updated skill ${artifact.slug} → revision ${revision.revisionNumber}.`, {
      skillId: artifact.id,
      slug: artifact.slug,
      revisionId: revision.revisionId,
      revisionNumber: revision.revisionNumber,
      gitTag: revision.gitTag,
      gitSha: revision.gitSha,
    });
    cacheSuccessfulResponse(req, { status: 200, body, locationHeader: null });
    return reply.code(200).send(body);
  });

  // ── C.3 deprecate ──────────────────────────────────────────
  app.post(`${SKILLS_BASE}/deprecate`, async (req, reply) => {
    if (!enforceRole(req, reply, WRITE_ROLES)) return reply;
    if (!requireDb(reply)) return reply;
    const parsed = deprecateSchema.safeParse(req.body ?? {});
    if (!parsed.success) { sendValidation(reply, parsed.error); return; }

    const mcp = req.mcp!;
    const db = getDb();
    const [artifact] = await db.select().from(skillArtifacts).where(eq(skillArtifacts.id, parsed.data.skillId)).limit(1);
    if (!artifact || artifact.companyId !== mcp.companyId) {
      return reply.code(404).send(failure(`Skill ${parsed.data.skillId} not found.`, "not_found", "never", "skill_exists"));
      return;
    }
    if (artifact.status === "deprecated") {
      return reply.code(409).send(failure(`Skill ${artifact.slug} is already deprecated.`, "conflict", "never", "skill_active"));
      return;
    }

    let revision: Awaited<ReturnType<typeof writeRevisionAtomic>>;
    try {
      revision = await writeRevisionAtomic({
        skillArtifactId: artifact.id,
        skillSlug: artifact.slug,
        content: "",
        intent: "deprecate",
        appliedBy: `${mcp.role}:${mcp.beatId}`,
        summary: parsed.data.summary,
      });
    } catch (err) {
      reply
        .code(500)
        .send(failure(`Failed to record deprecation: ${err instanceof Error ? err.message : String(err)}`, "internal", "unsafe", "retry_succeeded"));
      return;
    }

    await swallowAndAudit("skill.deprecate.row", () =>
      db.update(skillArtifacts)
        .set({ status: "deprecated", deprecatedAt: new Date(), updatedAt: new Date() })
        .where(eq(skillArtifacts.id, artifact.id))
        .then(() => undefined),
    { agentRole: "skills_lead", detail: { skillId: artifact.id, reason: parsed.data.reason } });

    try {
      deprecateSkillInMemory(artifact.id, parsed.data.reason);
    } catch {
      // non-fatal
    }

    const body = success(`Deprecated skill ${artifact.slug}.`, {
      skillId: artifact.id,
      slug: artifact.slug,
      revisionId: revision.revisionId,
      gitTag: revision.gitTag,
      reason: parsed.data.reason,
    });
    cacheSuccessfulResponse(req, { status: 200, body, locationHeader: null });
    return reply.code(200).send(body);
  });

  // ── G.1 candidate-submit ───────────────────────────────────
  // Allowlisted to ALL roles (per spec §Tool surface). Submits a candidate
  // skill idea for the orchestrator to evaluate. Behind
  // ARCEUS_SKILL_EVOLVE_TRIGGER_CANDIDATE=1.
  app.post(`${SKILLS_BASE}/candidate-submit`, async (req, reply) => {
    if (process.env.ARCEUS_SKILL_EVOLVE_TRIGGER_CANDIDATE !== "1") {
      reply
        .code(503)
        .send(failure("skill_candidate_submit is disabled (set ARCEUS_SKILL_EVOLVE_TRIGGER_CANDIDATE=1).", "upstream", "never", "trigger_enabled"));
      return;
    }
    if (!requireDb(reply)) return reply;
    const parsed = candidateSubmitSchema.safeParse(req.body ?? {});
    if (!parsed.success) { sendValidation(reply, parsed.error); return; }

    const mcp = req.mcp!;
    const db = getDb();
    const job = await enqueueJob(db, {
      companyId: mcp.companyId,
      trigger: "candidate",
      targetSkillId: null,
      payload: {
        description: parsed.data.description,
        motivation: parsed.data.motivation,
        submittedBy: `${mcp.role}:${mcp.beatId}`,
      },
    });

    const body = success(`Queued candidate skill for evaluation (job ${job.id}).`, {
      jobId: job.id,
      trigger: job.trigger,
      status: job.status,
    });
    return reply.code(202).send(body);
  });
}
