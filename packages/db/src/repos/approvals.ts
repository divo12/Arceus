import { and, desc, eq } from "drizzle-orm";
import { approvals } from "../schema/approvals.js";
import type { DbClient } from "./_helpers.js";

export type Approval = typeof approvals.$inferSelect;
export type NewApproval = typeof approvals.$inferInsert;

export async function createApproval(db: DbClient, data: NewApproval): Promise<Approval> {
  const [row] = await db.insert(approvals).values(data).returning();
  return row;
}

export async function findApprovalById(db: DbClient, id: string): Promise<Approval | null> {
  const [row] = await db.select().from(approvals).where(eq(approvals.id, id)).limit(1);
  return row ?? null;
}

export async function listApprovalsByCompany(
  db: DbClient,
  companyId: string,
  status?: string,
): Promise<Approval[]> {
  const conditions = [eq(approvals.companyId, companyId)];
  if (status) conditions.push(eq(approvals.status, status));
  return db
    .select()
    .from(approvals)
    .where(and(...conditions))
    .orderBy(desc(approvals.createdAt));
}

export async function decideApproval(
  db: DbClient,
  id: string,
  decision: "approved" | "rejected",
  decidedBy: string,
  note?: string,
): Promise<Approval | null> {
  const [row] = await db
    .update(approvals)
    .set({
      status: decision,
      decision,
      decisionNote: note,
      decidedAt: new Date(),
      decidedByUserId: decidedBy,
    })
    .where(and(eq(approvals.id, id), eq(approvals.status, "pending")))
    .returning();
  return row ?? null;
}
