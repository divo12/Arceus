import { and, desc, eq, inArray } from "drizzle-orm";
import { memoryUnits } from "../schema/memory_units.js";
import type { DbClient } from "./_helpers.js";

export type MemoryUnit = typeof memoryUnits.$inferSelect;
export type NewMemoryUnit = typeof memoryUnits.$inferInsert;

export async function createMemoryUnit(
  db: DbClient,
  data: NewMemoryUnit,
): Promise<MemoryUnit> {
  const [row] = await db.insert(memoryUnits).values(data).returning();
  return row;
}

export async function findMemoryUnitById(
  db: DbClient,
  id: string,
): Promise<MemoryUnit | null> {
  const [row] = await db.select().from(memoryUnits).where(eq(memoryUnits.id, id)).limit(1);
  return row ?? null;
}

export async function listMemoryUnitsByAgent(
  db: DbClient,
  agentId: string,
  types?: ("static" | "dynamic" | "procedural" | "priming" | "delegation")[],
  limit = 100,
): Promise<MemoryUnit[]> {
  const conditions = [eq(memoryUnits.agentId, agentId)];
  if (types && types.length > 0) {
    conditions.push(inArray(memoryUnits.type, types));
  }
  return db
    .select()
    .from(memoryUnits)
    .where(and(...conditions))
    .orderBy(desc(memoryUnits.createdAt))
    .limit(limit);
}

export async function deleteMemoryUnit(db: DbClient, id: string): Promise<boolean> {
  const result = await db
    .delete(memoryUnits)
    .where(eq(memoryUnits.id, id))
    .returning({ id: memoryUnits.id });
  return result.length === 1;
}
