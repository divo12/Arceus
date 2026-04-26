/**
 * Skill usage persistence — durable mirror for the in-memory skill
 * registry's success-rate EMA.
 *
 * Phase 5 PR #12. The runtime skill registry
 * (`packages/company-runtime/src/skill-registry.ts`) computes EMA in
 * memory; this module dual-writes both:
 *
 *   1. The skill_artifacts row (lazy-create on first usage so the
 *      FK target exists before we insert the event).
 *   2. One skill_usage_events row per invocation, carrying the verdict
 *      score for offline EMA recompute / dashboards.
 *
 * The skill registry already has `onSkillUsageRecorded` /
 * `onSkillSuccessRateChanged` hooks, but those don't carry the runtime
 * context (companyId, role, beatDbId). We invoke this module from
 * run-beat.ts where that context is in scope.
 */
import type { SkillArtifact as ContractSkill } from "@arceus/contracts";
import { getDb } from "@arceus/db";
import * as skillArtifactsRepo from "@arceus/db/src/repos/skill_artifacts.js";
import * as skillUsageEventsRepo from "@arceus/db/src/repos/skill_usage_events.js";
import * as agentsRepo from "@arceus/db/src/repos/agents.js";
import { toDbId as companyToDbId } from "@arceus/db/src/repos/companies.js";
import postgres from "postgres";

function pgErrorCode(err: unknown): string {
  if (err instanceof postgres.PostgresError) return err.code;
  if (err instanceof Error && err.cause instanceof postgres.PostgresError) {
    return err.cause.code;
  }
  return "unknown";
}

/** Compress trigger condition to slug-style identifier; falls back to id. */
function deriveSlug(skill: ContractSkill): string {
  const safe = skill.id.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  return safe || skill.id;
}

/**
 * Ensure the DB row for this skill exists (idempotent upsert) and return
 * its uuid. Called inline from `persistSkillUsageEvent` so callers don't
 * have to know about the FK relationship.
 */
async function ensureSkillRow(
  db: ReturnType<typeof getDb>,
  companyDbId: string,
  skill: ContractSkill,
): Promise<string> {
  const row = await skillArtifactsRepo.upsertSkillArtifact(db, {
    friendlyId: skill.id,
    companyId: skill.companyId,
    companyDbId,
    name: skill.name,
    slug: deriveSlug(skill),
    role: skill.role,
    triggerCondition: skill.trigger,
    description: skill.content.slice(0, 200),
    content: skill.content,
    successRate: skill.successRate,
    usageCount: skill.usageCount,
    status: skill.status === "draft" || skill.status === "deprecated" ? skill.status : "active",
    version: skill.version,
  });
  return row.id;
}

export interface PersistSkillUsageInput {
  skill: ContractSkill;
  companyId: string;
  role: string;
  beatDbId: string | null;
  outcomeScore: number;
}

/**
 * Mirror a single skill invocation to skill_usage_events. Idempotent only
 * by row count — repeated calls for the same logical event will produce
 * multiple rows. Designed for the post-beat loop where each `usedSkillId`
 * is recorded exactly once.
 */
export async function persistSkillUsageEvent(input: PersistSkillUsageInput): Promise<void> {
  const db = getDb();
  try {
    const companyDbId = companyToDbId(input.companyId);
    const skillDbId = await ensureSkillRow(db, companyDbId, input.skill);
    const agentDbId = await agentsRepo.resolveAgentDbId(db, companyDbId, input.role);
    await skillUsageEventsRepo.recordUsageEvent(db, {
      companyId: companyDbId,
      skillId: skillDbId,
      beatId: input.beatDbId,
      agentId: agentDbId,
      outcomeScore: input.outcomeScore,
    });
  } catch (err) {
    console.warn(
      `[skill_usage] event skipped for ${input.companyId}/${input.skill.id} (pg=${pgErrorCode(err)})`,
    );
  }
}
