import { and, desc, eq, sql } from "drizzle-orm";
import { skillArtifacts } from "../schema/skill_artifacts.js";
import type { DbClient } from "./_helpers.js";

export type SkillArtifact = typeof skillArtifacts.$inferSelect;
export type NewSkillArtifact = typeof skillArtifacts.$inferInsert;

export async function createSkill(
  db: DbClient,
  data: NewSkillArtifact,
): Promise<SkillArtifact> {
  const [row] = await db.insert(skillArtifacts).values(data).returning();
  return row;
}

export async function findSkillById(db: DbClient, id: string): Promise<SkillArtifact | null> {
  const [row] = await db.select().from(skillArtifacts).where(eq(skillArtifacts.id, id)).limit(1);
  return row ?? null;
}

export async function findSkillBySlug(
  db: DbClient,
  companyId: string,
  slug: string,
): Promise<SkillArtifact | null> {
  const [row] = await db
    .select()
    .from(skillArtifacts)
    .where(and(eq(skillArtifacts.companyId, companyId), eq(skillArtifacts.slug, slug)))
    .limit(1);
  return row ?? null;
}

export async function listActiveSkillsForRole(
  db: DbClient,
  companyId: string,
  role: string,
): Promise<SkillArtifact[]> {
  return db
    .select()
    .from(skillArtifacts)
    .where(
      and(
        eq(skillArtifacts.companyId, companyId),
        eq(skillArtifacts.role, role),
        eq(skillArtifacts.status, "active"),
      ),
    )
    .orderBy(desc(skillArtifacts.successRate));
}

export async function updateSkill(
  db: DbClient,
  id: string,
  patch: Partial<NewSkillArtifact>,
): Promise<SkillArtifact | null> {
  const [row] = await db
    .update(skillArtifacts)
    .set(patch)
    .where(eq(skillArtifacts.id, id))
    .returning();
  return row ?? null;
}

export async function recordUsage(db: DbClient, id: string): Promise<void> {
  await db
    .update(skillArtifacts)
    .set({
      usageCount: sql`${skillArtifacts.usageCount} + 1`,
      lastUsedAt: new Date(),
    })
    .where(eq(skillArtifacts.id, id));
}

export async function deprecateSkill(db: DbClient, id: string): Promise<SkillArtifact | null> {
  const [row] = await db
    .update(skillArtifacts)
    .set({ status: "deprecated", deprecatedAt: new Date() })
    .where(eq(skillArtifacts.id, id))
    .returning();
  return row ?? null;
}
