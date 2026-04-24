import { desc, eq } from "drizzle-orm";
import { skillRevisions } from "../schema/skill_revisions.js";
import type { DbClient } from "./_helpers.js";

export type SkillRevision = typeof skillRevisions.$inferSelect;
export type NewSkillRevision = typeof skillRevisions.$inferInsert;

export async function createRevision(
  db: DbClient,
  data: NewSkillRevision,
): Promise<SkillRevision> {
  const [row] = await db.insert(skillRevisions).values(data).returning();
  return row;
}

export async function listRevisions(db: DbClient, skillId: string): Promise<SkillRevision[]> {
  return db
    .select()
    .from(skillRevisions)
    .where(eq(skillRevisions.skillId, skillId))
    .orderBy(desc(skillRevisions.revisionNumber));
}

/** Latest revision for a skill (highest revision_number). Returns null if none. */
export async function latestRevisionForSkill(
  db: DbClient,
  skillId: string,
): Promise<SkillRevision | null> {
  const rows = await db
    .select()
    .from(skillRevisions)
    .where(eq(skillRevisions.skillId, skillId))
    .orderBy(desc(skillRevisions.revisionNumber))
    .limit(1);
  return rows[0] ?? null;
}

/** Lookup by exact git tag (UNIQUE constraint guarantees ≤ 1 row). */
export async function findRevisionByGitTag(
  db: DbClient,
  gitTag: string,
): Promise<SkillRevision | null> {
  const rows = await db
    .select()
    .from(skillRevisions)
    .where(eq(skillRevisions.gitTag, gitTag))
    .limit(1);
  return rows[0] ?? null;
}

/** Delete by id — only used by writeRevisionAtomic on rollback paths. */
export async function deleteRevisionById(db: DbClient, id: string): Promise<void> {
  await db.delete(skillRevisions).where(eq(skillRevisions.id, id));
}
