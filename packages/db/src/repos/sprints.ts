import { and, desc, eq } from "drizzle-orm";
import { sprints } from "../schema/sprints.js";
import type { DbClient } from "./_helpers.js";

export type Sprint = typeof sprints.$inferSelect;
export type NewSprint = typeof sprints.$inferInsert;

export async function createSprint(db: DbClient, data: NewSprint): Promise<Sprint> {
  const [row] = await db.insert(sprints).values(data).returning();
  return row;
}

export async function findSprintById(db: DbClient, id: string): Promise<Sprint | null> {
  const [row] = await db.select().from(sprints).where(eq(sprints.id, id)).limit(1);
  return row ?? null;
}

export async function getActiveSprint(db: DbClient, companyId: string): Promise<Sprint | null> {
  const [row] = await db
    .select()
    .from(sprints)
    .where(and(eq(sprints.companyId, companyId), eq(sprints.status, "active")))
    .orderBy(desc(sprints.sprintNumber))
    .limit(1);
  return row ?? null;
}

export async function listSprintsByCompany(db: DbClient, companyId: string): Promise<Sprint[]> {
  return db.select().from(sprints).where(eq(sprints.companyId, companyId)).orderBy(desc(sprints.sprintNumber));
}

export async function updateSprint(
  db: DbClient,
  id: string,
  patch: Partial<NewSprint>,
): Promise<Sprint | null> {
  const [row] = await db.update(sprints).set(patch).where(eq(sprints.id, id)).returning();
  return row ?? null;
}
