import { and, desc, eq, ne } from "drizzle-orm";
import type { StrategyBrief as ContractStrategy } from "@arceus/contracts";
import { strategyBriefs } from "../schema/strategy_briefs.js";
import type { DbClient } from "./_helpers.js";
import { friendlyToUuid } from "./_uuid.js";

export type StrategyBrief = typeof strategyBriefs.$inferSelect;
export type NewStrategyBrief = typeof strategyBriefs.$inferInsert;

export const toDbId = friendlyToUuid;
export const fromDbId = (uuid: string, friendlyHint?: string | null): string => friendlyHint ?? uuid;

// ── DB row ↔ contracts.StrategyBrief ───────────────────────

export function rowToStrategy(row: StrategyBrief): ContractStrategy {
  return {
    id: fromDbId(row.id, row.friendlyId),
    companyId: fromDbId(row.companyId),
    title: row.title,
    summary: row.summary,
    firstRelease: row.firstRelease,
    scopeBoundary: row.scopeBoundary ?? [],
    roleRationale: row.roleRationale ?? [],
    status: row.status as ContractStrategy["status"],
    createdByAgentId: row.createdByAgentId ? fromDbId(row.createdByAgentId) : "",
    createdAt: row.createdAt.toISOString(),
  };
}

export function strategyToInsert(strategy: ContractStrategy): NewStrategyBrief {
  return {
    id: toDbId(strategy.id),
    friendlyId: strategy.id,
    companyId: toDbId(strategy.companyId),
    title: strategy.title,
    summary: strategy.summary,
    firstRelease: strategy.firstRelease,
    scopeBoundary: strategy.scopeBoundary,
    roleRationale: strategy.roleRationale,
    status: strategy.status,
    createdByAgentId: strategy.createdByAgentId ? toDbId(strategy.createdByAgentId) : null,
  };
}

// ── Queries ────────────────────────────────────────────────

export async function findById(db: DbClient, id: string): Promise<StrategyBrief | null> {
  const [row] = await db.select().from(strategyBriefs).where(eq(strategyBriefs.id, toDbId(id))).limit(1);
  return row ?? null;
}

export async function findByIdHydrated(db: DbClient, id: string): Promise<ContractStrategy | null> {
  const row = await findById(db, id);
  return row ? rowToStrategy(row) : null;
}

/** Most-recent strategy for the company, regardless of status. */
export async function findLatestByCompany(db: DbClient, companyId: string): Promise<StrategyBrief | null> {
  const [row] = await db
    .select()
    .from(strategyBriefs)
    .where(eq(strategyBriefs.companyId, toDbId(companyId)))
    .orderBy(desc(strategyBriefs.createdAt))
    .limit(1);
  return row ?? null;
}

/** Approved or pending strategy — excludes superseded/rejected. */
export async function findActiveByCompany(db: DbClient, companyId: string): Promise<StrategyBrief | null> {
  const [row] = await db
    .select()
    .from(strategyBriefs)
    .where(
      and(
        eq(strategyBriefs.companyId, toDbId(companyId)),
        ne(strategyBriefs.status, "superseded"),
        ne(strategyBriefs.status, "rejected"),
      ),
    )
    .orderBy(desc(strategyBriefs.createdAt))
    .limit(1);
  return row ?? null;
}

export async function upsertStrategy(db: DbClient, strategy: ContractStrategy): Promise<StrategyBrief> {
  const { id, ...updateFields } = strategyToInsert(strategy);
  const [row] = await db
    .insert(strategyBriefs)
    .values({ id, ...updateFields })
    .onConflictDoUpdate({
      target: strategyBriefs.id,
      set: { ...updateFields, updatedAt: new Date() },
    })
    .returning();
  return row;
}

/** Mark older approved strategies as superseded when a new one is approved. */
export async function supersedePriorApproved(db: DbClient, companyId: string, exceptId: string): Promise<number> {
  const result = await db
    .update(strategyBriefs)
    .set({ status: "superseded", updatedAt: new Date() })
    .where(
      and(
        eq(strategyBriefs.companyId, toDbId(companyId)),
        eq(strategyBriefs.status, "approved"),
        ne(strategyBriefs.id, toDbId(exceptId)),
      ),
    )
    .returning({ id: strategyBriefs.id });
  return result.length;
}
