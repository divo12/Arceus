import { eq, sql } from "drizzle-orm";
import { companies } from "../schema/companies.js";
import type { DbClient } from "./_helpers.js";

export type Company = typeof companies.$inferSelect;
export type NewCompany = typeof companies.$inferInsert;

export async function createCompany(db: DbClient, data: NewCompany): Promise<Company> {
  const [row] = await db.insert(companies).values(data).returning();
  return row;
}

export async function findCompanyById(db: DbClient, id: string): Promise<Company | null> {
  const [row] = await db.select().from(companies).where(eq(companies.id, id)).limit(1);
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
  const [row] = await db.update(companies).set(patch).where(eq(companies.id, id)).returning();
  return row ?? null;
}

export async function setCompanyStatus(
  db: DbClient,
  id: string,
  status: "active" | "paused" | "archived",
): Promise<Company | null> {
  const [row] = await db
    .update(companies)
    .set({ status })
    .where(eq(companies.id, id))
    .returning();
  return row ?? null;
}

/** Atomically increment `task_counter` and return the new value. Used to mint TASK-N identifiers.
 *  Race-safe: the UPDATE takes an implicit row lock for the duration of the statement. */
export async function allocateTaskNumber(db: DbClient, companyId: string): Promise<number> {
  const [row] = await db
    .update(companies)
    .set({ taskCounter: sql`${companies.taskCounter} + 1` })
    .where(eq(companies.id, companyId))
    .returning({ taskCounter: companies.taskCounter });
  if (!row) throw new Error(`Company ${companyId} not found`);
  return row.taskCounter;
}
