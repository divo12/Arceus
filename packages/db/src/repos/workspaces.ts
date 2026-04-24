import { eq } from "drizzle-orm";
import { workspaces } from "../schema/workspaces.js";
import type { DbClient } from "./_helpers.js";

export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;

export async function createWorkspace(db: DbClient, data: NewWorkspace): Promise<Workspace> {
  const [row] = await db.insert(workspaces).values(data).returning();
  return row;
}

export async function getWorkspace(db: DbClient, companyId: string): Promise<Workspace | null> {
  const [row] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.companyId, companyId))
    .limit(1);
  return row ?? null;
}

export async function updateWorkspace(
  db: DbClient,
  companyId: string,
  patch: Partial<NewWorkspace>,
): Promise<Workspace | null> {
  const [row] = await db
    .update(workspaces)
    .set(patch)
    .where(eq(workspaces.companyId, companyId))
    .returning();
  return row ?? null;
}
