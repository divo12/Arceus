/**
 * Spec 23 Pass 3: DB write-through for the skill registry.
 *
 * Persists skill EMA + usage counts to `arceus.skill_artifacts` so they
 * survive process restart. Behind feature flag `ARCEUS_SKILLS_DB_WRITETHROUGH=1`.
 *
 * Without the flag, this module is a no-op and the registry behaves as
 * pure in-memory (current behavior). When enabled:
 *   - on boot: load DB rows → hydrateSkill() (no callbacks fire), then
 *     seedExistingSkills() runs in "preserve" mode so DB rows win on collision.
 *   - at runtime: registerSkill / updateSkill / deprecateSkill /
 *     recordSkillUsage / updateSuccessRate fire callbacks that upsert the row.
 *
 * All writes are fire-and-forget: failures log a warning but never throw
 * back into the registry mutator (no behavioral change without DB).
 */

import type { SkillArtifact } from "@arceus/contracts";
import { hydrateSkill } from "@arceus/company-runtime";
import { isDatabaseConfigured, getDb } from "@arceus/db";
import { skillArtifactsTable } from "@arceus/db";
import { eq, and } from "drizzle-orm";

const FLAG_ENV = "ARCEUS_SKILLS_DB_WRITETHROUGH";

export function isSkillsDbWritethroughEnabled(): boolean {
  return process.env[FLAG_ENV] === "1" && isDatabaseConfigured();
}

// ── Mapping ───────────────────────────────────────────────

function toRow(skill: SkillArtifact): typeof skillArtifactsTable.$inferInsert {
  return {
    id: skill.id,
    companyId: skill.companyId,
    name: skill.name,
    role: skill.role,
    version: skill.version,
    status: skill.status,
    triggerCondition: skill.trigger,
    content: skill.content,
    testCases: skill.testCases as unknown,
    successRate: skill.successRate,
    usageCount: skill.usageCount,
    lastUsedAt: skill.lastUsedAt ? new Date(skill.lastUsedAt) : null,
    mutatedFromId: skill.mutatedFromId,
    mutatedBy: skill.mutatedBy,
    mutationReason: skill.mutationReason,
    createdAt: skill.createdAt ? new Date(skill.createdAt) : new Date(),
    approvedAt: skill.approvedAt ? new Date(skill.approvedAt) : null,
  } as typeof skillArtifactsTable.$inferInsert;
}

function fromRow(row: typeof skillArtifactsTable.$inferSelect): SkillArtifact {
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    role: row.role,
    version: row.version,
    status: row.status as SkillArtifact["status"],
    trigger: row.triggerCondition,
    content: row.content,
    testCases: (row.testCases as SkillArtifact["testCases"]) ?? [],
    successRate: Number(row.successRate),
    usageCount: row.usageCount,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    mutatedFromId: row.mutatedFromId ?? null,
    mutatedBy: row.mutatedBy ?? null,
    mutationReason: row.mutationReason ?? null,
    createdAt: row.createdAt.toISOString(),
    approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
    resources: [],
  };
}

// ── Persistence ───────────────────────────────────────────

/** Upsert a skill row. Fire-and-forget — logs on failure, never throws. */
export function dbPersistSkill(skill: SkillArtifact): void {
  if (!isSkillsDbWritethroughEnabled()) return;
  const row = toRow(skill);
  void getDb()
    .insert(skillArtifactsTable)
    .values(row)
    .onConflictDoUpdate({
      target: skillArtifactsTable.id,
      set: {
        name: row.name,
        role: row.role,
        version: row.version,
        status: row.status,
        triggerCondition: row.triggerCondition,
        content: row.content,
        testCases: row.testCases,
        successRate: row.successRate,
        usageCount: row.usageCount,
        lastUsedAt: row.lastUsedAt,
        mutatedFromId: row.mutatedFromId,
        mutatedBy: row.mutatedBy,
        mutationReason: row.mutationReason,
        approvedAt: row.approvedAt,
      },
    })
    .catch((err: unknown) => {
      console.warn(
        `[SkillDB] Failed to persist skill ${skill.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
}

/** Load all skills for a company. Returns [] on failure (logs warning). */
export async function dbLoadSkillsForCompany(companyId: string): Promise<SkillArtifact[]> {
  if (!isSkillsDbWritethroughEnabled()) return [];
  try {
    const rows = await getDb()
      .select()
      .from(skillArtifactsTable)
      .where(eq(skillArtifactsTable.companyId, companyId));
    return rows.map(fromRow);
  } catch (err) {
    console.warn(
      `[SkillDB] Failed to load skills for ${companyId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/**
 * Hydrate the in-memory registry from DB. Call once at boot, BEFORE
 * `seedExistingSkills()`. Idempotent — calling twice just rewrites the
 * in-memory rows. No write-back fires (uses hydrateSkill).
 *
 * Returns the count loaded, or 0 if the flag is off / DB not configured.
 */
export async function hydrateSkillRegistryFromDb(companyId: string): Promise<number> {
  if (!isSkillsDbWritethroughEnabled()) return 0;
  const skills = await dbLoadSkillsForCompany(companyId);
  for (const s of skills) hydrateSkill(s);
  if (skills.length > 0) {
    console.log(`[SkillDB] Hydrated ${skills.length} skills from DB for company ${companyId}`);
  }
  return skills.length;
}

// Suppress unused import warning when nothing else uses `and` here
void and;
