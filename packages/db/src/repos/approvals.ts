import { and, desc, eq } from "drizzle-orm";
import { v5 as uuidv5 } from "uuid";
import type { Approval as ContractApproval } from "@arceus/contracts";
import { approvals } from "../schema/approvals.js";
import type { DbClient } from "./_helpers.js";

export type Approval = typeof approvals.$inferSelect;
export type NewApproval = typeof approvals.$inferInsert;

// ── ID boundary: friendly strings ↔ uuid (Phase 4E) ──────────────
const ARCEUS_UUID_NS = "8eb53fc9-9111-4f3f-a16d-0c8f7e2c7bb5";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const toDbId = (friendly: string): string =>
  UUID_RE.test(friendly) ? friendly : uuidv5(friendly, ARCEUS_UUID_NS);

export const fromDbId = (uuid: string, friendlyHint?: string | null): string =>
  friendlyHint ?? uuid;

export async function createApproval(db: DbClient, data: NewApproval): Promise<Approval> {
  const [row] = await db.insert(approvals).values(data).returning();
  return row;
}

export async function findApprovalById(db: DbClient, id: string): Promise<Approval | null> {
  const [row] = await db.select().from(approvals).where(eq(approvals.id, toDbId(id))).limit(1);
  return row ?? null;
}

export async function listApprovalsByCompany(
  db: DbClient,
  companyId: string,
  status?: string,
): Promise<Approval[]> {
  const conditions = [eq(approvals.companyId, toDbId(companyId))];
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
    .where(and(eq(approvals.id, toDbId(id)), eq(approvals.status, "pending")))
    .returning();
  return row ?? null;
}

// ── Hydration: DB row ↔ contracts.Approval (Phase 4E) ────────────

/** Pure transform from DB row to contracts.Approval. */
export function rowToApproval(row: Approval): ContractApproval {
  return {
    id: fromDbId(row.id, row.friendlyId),
    companyId: row.companyId,
    type: row.kind as ContractApproval["type"],
    status: row.status as ContractApproval["status"],
    title: row.title,
    description: row.description ?? "",
    requestedByAgentId: row.requestedByAgentId ?? "",
    meetingId: row.meetingId,
    agendaItemId: row.agendaItemId,
    resolutionSummary: row.resolutionSummary,
  };
}

/** Build the insert payload from a contracts.Approval. */
export function approvalToInsert(approval: ContractApproval): NewApproval {
  return {
    id: toDbId(approval.id),
    friendlyId: approval.id,
    companyId: toDbId(approval.companyId),
    kind: approval.type,
    status: approval.status,
    title: approval.title,
    description: approval.description,
    meetingId: approval.meetingId,
    agendaItemId: approval.agendaItemId,
    resolutionSummary: approval.resolutionSummary,
    requestedByAgentId: approval.requestedByAgentId ? toDbId(approval.requestedByAgentId) : null,
    payload: {},
  };
}

/** Insert-or-replace for the dual-write path. */
export async function upsertApproval(db: DbClient, approval: ContractApproval): Promise<Approval> {
  const { id, ...updateFields } = approvalToInsert(approval);
  const [row] = await db
    .insert(approvals)
    .values({ id, ...updateFields })
    .onConflictDoUpdate({ target: approvals.id, set: updateFields })
    .returning();
  return row;
}

export async function findByIdHydrated(db: DbClient, id: string): Promise<ContractApproval | null> {
  const row = await findApprovalById(db, id);
  return row ? rowToApproval(row) : null;
}
