import { eq, sql } from "drizzle-orm";
import type { Company as ContractCompany, CompanyStatus } from "@arceus/contracts";
import { companies } from "../schema/companies.js";
import type { DbClient } from "./_helpers.js";
import { friendlyToUuid } from "./_uuid.js";

export type Company = typeof companies.$inferSelect;
export type NewCompany = typeof companies.$inferInsert;

// ── ID boundary: friendly strings ↔ uuid (Phase 4A) ──────────────
//
// Same trick as repos/tasks.ts: the runtime hands us friendly ids like
// `company_xxx`, the schema column is uuid (FK type matches every other
// table). `toDbId` converts deterministically via `_uuid.friendlyToUuid`;
// `friendlyId` is stored alongside so hydration round-trips back to the
// original string.
export const toDbId = friendlyToUuid;

export function fromDbId(uuid: string, friendlyHint?: string | null): string {
  return friendlyHint ?? uuid;
}

export async function createCompany(db: DbClient, data: NewCompany): Promise<Company> {
  const [row] = await db.insert(companies).values(data).returning();
  return row;
}

export async function findCompanyById(db: DbClient, id: string): Promise<Company | null> {
  const [row] = await db.select().from(companies).where(eq(companies.id, toDbId(id))).limit(1);
  return row ?? null;
}

export async function findCompanyBySlug(db: DbClient, slug: string): Promise<Company | null> {
  const [row] = await db.select().from(companies).where(eq(companies.slug, slug)).limit(1);
  return row ?? null;
}

export async function listCompanies(db: DbClient): Promise<Company[]> {
  return db.select().from(companies);
}

export async function updateCompany(
  db: DbClient,
  id: string,
  patch: Partial<NewCompany>,
): Promise<Company | null> {
  const [row] = await db.update(companies).set(patch).where(eq(companies.id, toDbId(id))).returning();
  return row ?? null;
}

export async function setCompanyStatus(
  db: DbClient,
  id: string,
  status: CompanyStatus,
): Promise<Company | null> {
  const [row] = await db
    .update(companies)
    .set({ status })
    .where(eq(companies.id, toDbId(id)))
    .returning();
  return row ?? null;
}

/** Atomically increment `task_counter` and return the new value. Used to mint TASK-N identifiers.
 *  Race-safe: the UPDATE takes an implicit row lock for the duration of the statement. */
export async function allocateTaskNumber(db: DbClient, companyId: string): Promise<number> {
  const [row] = await db
    .update(companies)
    .set({ taskCounter: sql`${companies.taskCounter} + 1` })
    .where(eq(companies.id, toDbId(companyId)))
    .returning({ taskCounter: companies.taskCounter });
  if (!row) throw new Error(`Company ${companyId} not found`);
  return row.taskCounter;
}

// ── Hydration: DB row ↔ contracts.Company (Phase 4A) ──────────────

/** Pure transform from a DB row to a contracts.Company. */
export function rowToCompany(row: Company): ContractCompany {
  return {
    id: fromDbId(row.id, row.friendlyId),
    name: row.name,
    boardOwner: row.boardOwner ?? row.boardOwnerEmail ?? "",
    goal: row.goal ?? "",
    budgetCents: row.budgetCents,
    spentCents: row.spentCents,
    status: row.status as ContractCompany["status"],
    currentStrategyId: row.currentStrategyId ?? "",
    currentSprintId: row.currentSprintId,
    currentSprintNumber: row.currentSprintNumber,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Build the insert payload for a contracts.Company. uuidv5-converts the
 * friendly id, stashes the original string in `friendly_id` for round-trip,
 * and maps every contract field to its column.
 */
export function companyToInsert(company: ContractCompany): NewCompany {
  return {
    id: toDbId(company.id),
    friendlyId: company.id,
    name: company.name,
    boardOwner: company.boardOwner,
    goal: company.goal,
    budgetCents: company.budgetCents,
    spentCents: company.spentCents,
    status: company.status,
    currentStrategyId: company.currentStrategyId || null,
    currentSprintId: company.currentSprintId,
    currentSprintNumber: company.currentSprintNumber,
  };
}

/**
 * Insert a company or replace it on conflict. The dual-write path in
 * `apps/api/src/persistence/company-persistence.ts` calls this after
 * every store mutation to keep the DB in sync.
 */
export async function upsertCompany(db: DbClient, company: ContractCompany): Promise<Company> {
  const { id, ...updateFields } = companyToInsert(company);
  const [row] = await db
    .insert(companies)
    .values({ id, ...updateFields })
    .onConflictDoUpdate({ target: companies.id, set: updateFields })
    .returning();
  return row;
}

/** Find a company by friendly id and return it as a fully-hydrated contracts.Company. */
export async function findByIdHydrated(db: DbClient, id: string): Promise<ContractCompany | null> {
  const row = await findCompanyById(db, id);
  return row ? rowToCompany(row) : null;
}
