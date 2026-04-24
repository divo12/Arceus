import { desc, eq } from "drizzle-orm";
import { sprintSnapshots } from "../schema/sprint_snapshots.js";
import type { DbClient } from "./_helpers.js";

export type SprintSnapshot = typeof sprintSnapshots.$inferSelect;
export type NewSprintSnapshot = typeof sprintSnapshots.$inferInsert;

export async function createSnapshot(
  db: DbClient,
  data: NewSprintSnapshot,
): Promise<SprintSnapshot> {
  const [row] = await db.insert(sprintSnapshots).values(data).returning();
  return row;
}

export async function listSnapshotsByCompany(
  db: DbClient,
  companyId: string,
): Promise<SprintSnapshot[]> {
  return db
    .select()
    .from(sprintSnapshots)
    .where(eq(sprintSnapshots.companyId, companyId))
    .orderBy(desc(sprintSnapshots.sprintNumber));
}

export async function findSnapshotByTag(
  db: DbClient,
  gitTag: string,
): Promise<SprintSnapshot | null> {
  const [row] = await db
    .select()
    .from(sprintSnapshots)
    .where(eq(sprintSnapshots.gitTag, gitTag))
    .limit(1);
  return row ?? null;
}

export async function markRolledBack(db: DbClient, id: string): Promise<SprintSnapshot | null> {
  const [row] = await db
    .update(sprintSnapshots)
    .set({ status: "rolled_back" })
    .where(eq(sprintSnapshots.id, id))
    .returning();
  return row ?? null;
}
