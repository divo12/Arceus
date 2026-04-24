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
