import { and, eq } from "drizzle-orm";
import { agents } from "../schema/agents.js";
import type { DbClient } from "./_helpers.js";

export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;

export async function createAgent(db: DbClient, data: NewAgent): Promise<Agent> {
  const [row] = await db.insert(agents).values(data).returning();
  return row;
}

export async function findAgentById(db: DbClient, id: string): Promise<Agent | null> {
  const [row] = await db.select().from(agents).where(eq(agents.id, id)).limit(1);
  return row ?? null;
}

export async function findAgentByRole(
  db: DbClient,
  companyId: string,
  role: string,
): Promise<Agent | null> {
  const [row] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.role, role)))
    .limit(1);
  return row ?? null;
}

export async function listAgentsByCompany(db: DbClient, companyId: string): Promise<Agent[]> {
  return db.select().from(agents).where(eq(agents.companyId, companyId));
}

export async function updateAgent(
  db: DbClient,
  id: string,
  patch: Partial<NewAgent>,
): Promise<Agent | null> {
  const [row] = await db.update(agents).set(patch).where(eq(agents.id, id)).returning();
  return row ?? null;
}
