import { desc, eq, sql } from "drizzle-orm";
import { skillUsageEvents } from "../schema/skill_usage_events.js";
import type { DbClient } from "./_helpers.js";

export type SkillUsageEvent = typeof skillUsageEvents.$inferSelect;
export type NewSkillUsageEvent = typeof skillUsageEvents.$inferInsert;

export async function recordUsageEvent(
  db: DbClient,
  data: NewSkillUsageEvent,
): Promise<SkillUsageEvent> {
  const [row] = await db.insert(skillUsageEvents).values(data).returning();
  return row;
}

/** EMA-ready: returns recent outcome scores, newest first, capped. */
export async function recentOutcomes(
  db: DbClient,
  skillId: string,
  limit = 50,
): Promise<{ outcomeScore: number; occurredAt: Date }[]> {
  const rows = await db
    .select({ outcomeScore: skillUsageEvents.outcomeScore, occurredAt: skillUsageEvents.occurredAt })
    .from(skillUsageEvents)
    .where(eq(skillUsageEvents.skillId, skillId))
    .orderBy(desc(skillUsageEvents.occurredAt))
    .limit(limit);
  return rows;
}

/** Compute a simple average pass rate for EMA-drop trigger. */
export async function averagePassRate(db: DbClient, skillId: string, window = 50): Promise<number | null> {
  const [row] = await db.execute<{ avg: string | null }>(sql`
    SELECT AVG(outcome_score)::text AS avg FROM (
      SELECT outcome_score FROM skill_usage_events
       WHERE skill_id = ${skillId}
       ORDER BY occurred_at DESC
       LIMIT ${window}
    ) s
  `) as unknown as { avg: string | null }[];
  if (!row?.avg) return null;
  return Number(row.avg);
}
