import { eq } from "drizzle-orm";
import type { FundamentalIdea as ContractIdea } from "@arceus/contracts";
import { ideas } from "../schema/ideas.js";
import type { DbClient } from "./_helpers.js";
import { friendlyToUuid } from "./_uuid.js";

export type Idea = typeof ideas.$inferSelect;
export type NewIdea = typeof ideas.$inferInsert;

export const toDbId = friendlyToUuid;
export const fromDbId = (uuid: string, friendlyHint?: string | null): string => friendlyHint ?? uuid;

// ── DB row ↔ contracts.FundamentalIdea ─────────────────────

export function rowToIdea(row: Idea): ContractIdea {
  return {
    id: fromDbId(row.id, row.friendlyId),
    companyId: fromDbId(row.companyId),
    coreIdea: row.coreIdea,
    currentDirection: row.currentDirection,
    refinedWithBoard: row.refinedWithBoard,
  };
}

export function ideaToInsert(idea: ContractIdea): NewIdea {
  return {
    id: toDbId(idea.id),
    friendlyId: idea.id,
    companyId: toDbId(idea.companyId),
    coreIdea: idea.coreIdea,
    currentDirection: idea.currentDirection,
    refinedWithBoard: idea.refinedWithBoard,
  };
}

// ── Queries ────────────────────────────────────────────────

/**
 * Find the single idea row for a company. Companies have at most
 * one idea (enforced by `ideas_company_unique_idx`).
 */
export async function findByCompany(db: DbClient, companyId: string): Promise<Idea | null> {
  const [row] = await db.select().from(ideas).where(eq(ideas.companyId, toDbId(companyId))).limit(1);
  return row ?? null;
}

export async function findByCompanyHydrated(db: DbClient, companyId: string): Promise<ContractIdea | null> {
  const row = await findByCompany(db, companyId);
  return row ? rowToIdea(row) : null;
}

/**
 * Insert or replace the company's idea. The `companies_unique_idx`
 * makes this an effective upsert keyed on `company_id`.
 */
export async function upsertIdea(db: DbClient, idea: ContractIdea): Promise<Idea> {
  const insert = ideaToInsert(idea);
  const [row] = await db
    .insert(ideas)
    .values(insert)
    .onConflictDoUpdate({
      target: ideas.companyId,
      set: {
        coreIdea: insert.coreIdea,
        currentDirection: insert.currentDirection,
        refinedWithBoard: insert.refinedWithBoard,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row;
}
