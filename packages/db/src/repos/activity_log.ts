import { and, desc, eq } from "drizzle-orm";
import { activityLog } from "../schema/activity_log.js";
import type { DbClient } from "./_helpers.js";

export type ActivityEvent = typeof activityLog.$inferSelect;
export type NewActivityEvent = typeof activityLog.$inferInsert;

export async function appendActivity(
  db: DbClient,
  data: NewActivityEvent,
): Promise<ActivityEvent> {
  const [row] = await db.insert(activityLog).values(data).returning();
  return row;
}

export async function listActivityByCompany(
  db: DbClient,
  companyId: string,
  limit = 100,
): Promise<ActivityEvent[]> {
  return db
    .select()
    .from(activityLog)
    .where(eq(activityLog.companyId, companyId))
    .orderBy(desc(activityLog.createdAt))
    .limit(limit);
}

export async function listActivityByEntity(
  db: DbClient,
  entityType: string,
  entityId: string,
  limit = 100,
): Promise<ActivityEvent[]> {
  return db
    .select()
    .from(activityLog)
    .where(and(eq(activityLog.entityType, entityType), eq(activityLog.entityId, entityId)))
    .orderBy(desc(activityLog.createdAt))
    .limit(limit);
}
