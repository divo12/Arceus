import { and, desc, eq, gte, sql } from "drizzle-orm";
import { costEvents } from "../schema/cost_events.js";
import type { DbClient } from "./_helpers.js";

export type CostEvent = typeof costEvents.$inferSelect;
export type NewCostEvent = typeof costEvents.$inferInsert;

export async function recordCost(db: DbClient, data: NewCostEvent): Promise<CostEvent> {
  const [row] = await db.insert(costEvents).values(data).returning();
  return row;
}

export async function listCostsByCompany(
  db: DbClient,
  companyId: string,
  since?: Date,
  limit = 100,
): Promise<CostEvent[]> {
  const conditions = [eq(costEvents.companyId, companyId)];
  if (since) conditions.push(gte(costEvents.occurredAt, since));
  return db
    .select()
    .from(costEvents)
    .where(and(...conditions))
    .orderBy(desc(costEvents.occurredAt))
    .limit(limit);
}

/** Sum spend per provider over a time window. */
export async function spendByProvider(
  db: DbClient,
  companyId: string,
  since: Date,
): Promise<{ provider: string; costCents: number }[]> {
  const rows = await db.execute<{ provider: string; total: string }>(sql`
    SELECT provider, SUM(cost_cents)::text AS total
      FROM cost_events
     WHERE company_id = ${companyId} AND occurred_at >= ${since}
     GROUP BY provider
     ORDER BY SUM(cost_cents) DESC
  `) as unknown as { provider: string; total: string }[];
  return rows.map((r) => ({ provider: r.provider, costCents: Number(r.total) }));
}
