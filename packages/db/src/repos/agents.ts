import { and, eq } from "drizzle-orm";
import { v5 as uuidv5 } from "uuid";
import type { AgentIdentity as ContractAgent } from "@arceus/contracts";
import { agents } from "../schema/agents.js";
import type { DbClient } from "./_helpers.js";

export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;

// ── ID boundary: friendly strings ↔ uuid (Phase 5) ────────────────
const ARCEUS_UUID_NS = "8eb53fc9-9111-4f3f-a16d-0c8f7e2c7bb5";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const toDbId = (friendly: string): string =>
  UUID_RE.test(friendly) ? friendly : uuidv5(friendly, ARCEUS_UUID_NS);

export const fromDbId = (uuid: string, friendlyHint?: string | null): string =>
  friendlyHint ?? uuid;

export async function createAgent(db: DbClient, data: NewAgent): Promise<Agent> {
  const [row] = await db.insert(agents).values(data).returning();
  return row;
}

export async function findAgentById(db: DbClient, id: string): Promise<Agent | null> {
  const [row] = await db.select().from(agents).where(eq(agents.id, toDbId(id))).limit(1);
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
    .where(and(eq(agents.companyId, toDbId(companyId)), eq(agents.role, role)))
    .limit(1);
  return row ?? null;
}

export async function listAgentsByCompany(db: DbClient, companyId: string): Promise<Agent[]> {
  return db.select().from(agents).where(eq(agents.companyId, toDbId(companyId)));
}

export async function updateAgent(
  db: DbClient,
  id: string,
  patch: Partial<NewAgent>,
): Promise<Agent | null> {
  const [row] = await db.update(agents).set(patch).where(eq(agents.id, toDbId(id))).returning();
  return row ?? null;
}

// ── Hydration: contracts.AgentIdentity ↔ DB row (Phase 5) ────────

const ROLE_NAMES: Record<string, string> = {
  ceo: "Avery",
  cto: "Lin",
  pm: "Mina",
  developer: "Jules",
  tester: "Quinn",
  ui_designer: "Sage",
  marketing: "Parker",
  skills_lead: "Rowan",
};

/** Build the insert payload from a contracts.AgentIdentity. */
export function agentToInsert(agent: ContractAgent): NewAgent {
  return {
    id: toDbId(agent.id),
    friendlyId: agent.id,
    companyId: toDbId(agent.companyId),
    role: agent.role,
    displayName: agent.name || ROLE_NAMES[agent.role] || agent.role,
    soulPromptRef: null,
    isInternal: false,
  };
}

/** Insert-or-replace for the dual-write path. */
export async function upsertAgent(db: DbClient, agent: ContractAgent): Promise<Agent> {
  const insert = agentToInsert(agent);
  const [row] = await db
    .insert(agents)
    .values(insert)
    .onConflictDoUpdate({
      target: [agents.companyId, agents.role],
      set: {
        friendlyId: insert.friendlyId,
        displayName: insert.displayName,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row;
}

/** Resolve the DB uuid for a (companyId, role) pair — null if no agent yet. */
export async function resolveAgentDbId(
  db: DbClient,
  companyId: string,
  role: string,
): Promise<string | null> {
  const row = await findAgentByRole(db, companyId, role);
  return row?.id ?? null;
}
