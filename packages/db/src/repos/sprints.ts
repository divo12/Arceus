import { and, desc, eq } from "drizzle-orm";
import { v5 as uuidv5 } from "uuid";
import type { Sprint as ContractSprint, SprintReviewState } from "@arceus/contracts";
import { sprints } from "../schema/sprints.js";
import type { DbClient } from "./_helpers.js";

export type Sprint = typeof sprints.$inferSelect;
export type NewSprint = typeof sprints.$inferInsert;

// ── ID boundary: friendly strings ↔ uuid (Phase 4B) ──────────────
//
// Same trick as repos/tasks.ts and repos/companies.ts: app gives us
// `spr_xxx`, schema column is uuid. Convert deterministically; round-trip
// the original string via `friendly_id`.
const ARCEUS_UUID_NS = "8eb53fc9-9111-4f3f-a16d-0c8f7e2c7bb5";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const toDbId = (friendly: string): string =>
  UUID_RE.test(friendly) ? friendly : uuidv5(friendly, ARCEUS_UUID_NS);

export const fromDbId = (uuid: string, friendlyHint?: string | null): string =>
  friendlyHint ?? uuid;

export async function createSprint(db: DbClient, data: NewSprint): Promise<Sprint> {
  const [row] = await db.insert(sprints).values(data).returning();
  return row;
}

export async function findSprintById(db: DbClient, id: string): Promise<Sprint | null> {
  const [row] = await db.select().from(sprints).where(eq(sprints.id, toDbId(id))).limit(1);
  return row ?? null;
}

export async function getActiveSprint(db: DbClient, companyId: string): Promise<Sprint | null> {
  const [row] = await db
    .select()
    .from(sprints)
    .where(and(eq(sprints.companyId, toDbId(companyId)), eq(sprints.status, "executing")))
    .orderBy(desc(sprints.sprintNumber))
    .limit(1);
  return row ?? null;
}

export async function listSprintsByCompany(db: DbClient, companyId: string): Promise<Sprint[]> {
  return db.select().from(sprints).where(eq(sprints.companyId, toDbId(companyId))).orderBy(desc(sprints.sprintNumber));
}

export async function updateSprint(
  db: DbClient,
  id: string,
  patch: Partial<NewSprint>,
): Promise<Sprint | null> {
  const [row] = await db.update(sprints).set(patch).where(eq(sprints.id, toDbId(id))).returning();
  return row ?? null;
}

// ── Hydration: DB row ↔ contracts.Sprint (Phase 4B) ──────────────

/** Pure transform from DB row to contracts.Sprint. */
export function rowToSprint(row: Sprint): ContractSprint {
  return {
    id: fromDbId(row.id, row.friendlyId),
    companyId: row.companyId,
    strategyId: row.strategyId,
    number: row.sprintNumber ?? 0,
    title: row.title ?? "",
    goal: row.goal ?? "",
    status: row.status as ContractSprint["status"],
    plannedByAgentId: row.plannedByAgentId,
    summary: row.summary,
    reviewState: (row.reviewState as SprintReviewState | null) ?? null,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.endedAt?.toISOString() ?? null,
  };
}

/** Build the insert payload from a contracts.Sprint. */
export function sprintToInsert(sprint: ContractSprint): NewSprint {
  return {
    id: toDbId(sprint.id),
    friendlyId: sprint.id,
    companyId: toDbId(sprint.companyId),
    sprintNumber: sprint.number,
    title: sprint.title,
    goal: sprint.goal,
    summary: sprint.summary,
    strategyId: sprint.strategyId,
    plannedByAgentId: sprint.plannedByAgentId,
    reviewState: (sprint.reviewState as Record<string, unknown> | null) ?? null,
    status: sprint.status,
    startedAt: sprint.startedAt ? new Date(sprint.startedAt) : null,
    endedAt: sprint.completedAt ? new Date(sprint.completedAt) : null,
  };
}

/** Insert-or-replace for the dual-write path. */
export async function upsertSprint(db: DbClient, sprint: ContractSprint): Promise<Sprint> {
  const { id, ...updateFields } = sprintToInsert(sprint);
  const [row] = await db
    .insert(sprints)
    .values({ id, ...updateFields })
    .onConflictDoUpdate({ target: sprints.id, set: updateFields })
    .returning();
  return row;
}

export async function findByIdHydrated(db: DbClient, id: string): Promise<ContractSprint | null> {
  const row = await findSprintById(db, id);
  return row ? rowToSprint(row) : null;
}
