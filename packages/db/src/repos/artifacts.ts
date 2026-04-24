import { and, desc, eq } from "drizzle-orm";
import { artifacts } from "../schema/artifacts.js";
import type { DbClient } from "./_helpers.js";

export type Artifact = typeof artifacts.$inferSelect;
export type NewArtifact = typeof artifacts.$inferInsert;

export async function createArtifact(db: DbClient, data: NewArtifact): Promise<Artifact> {
  const [row] = await db.insert(artifacts).values(data).returning();
  return row;
}

export async function findArtifactById(db: DbClient, id: string): Promise<Artifact | null> {
  const [row] = await db.select().from(artifacts).where(eq(artifacts.id, id)).limit(1);
  return row ?? null;
}

export async function listArtifactsByTask(db: DbClient, taskId: string): Promise<Artifact[]> {
  return db
    .select()
    .from(artifacts)
    .where(eq(artifacts.taskId, taskId))
    .orderBy(desc(artifacts.createdAt));
}

export async function listArtifactsBySprint(db: DbClient, sprintId: string): Promise<Artifact[]> {
  return db
    .select()
    .from(artifacts)
    .where(eq(artifacts.sprintId, sprintId))
    .orderBy(desc(artifacts.createdAt));
}

export async function listArtifactsByCompany(
  db: DbClient,
  companyId: string,
  limit = 50,
): Promise<Artifact[]> {
  return db
    .select()
    .from(artifacts)
    .where(eq(artifacts.companyId, companyId))
    .orderBy(desc(artifacts.createdAt))
    .limit(limit);
}

export async function listArtifactsByKind(
  db: DbClient,
  companyId: string,
  kind: string,
): Promise<Artifact[]> {
  return db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.companyId, companyId), eq(artifacts.kind, kind)))
    .orderBy(desc(artifacts.createdAt));
}
