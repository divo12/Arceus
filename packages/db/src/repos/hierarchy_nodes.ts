import { eq } from "drizzle-orm";
import type { HierarchyNode as ContractNode, RoleType } from "@arceus/contracts";
import { hierarchyNodes } from "../schema/hierarchy_nodes.js";
import type { DbClient } from "./_helpers.js";
import { friendlyToUuid } from "./_uuid.js";

export type HierarchyNode = typeof hierarchyNodes.$inferSelect;
export type NewHierarchyNode = typeof hierarchyNodes.$inferInsert;

export const toDbId = friendlyToUuid;
export const fromDbId = (uuid: string, friendlyHint?: string | null): string => friendlyHint ?? uuid;

// ── DB row ↔ contracts.HierarchyNode ───────────────────────

export function rowToNode(row: HierarchyNode): ContractNode {
  return {
    id: fromDbId(row.id, row.friendlyId),
    role: row.role as RoleType,
    title: row.title,
    level: row.level,
    parentNodeId: row.parentNodeId ? fromDbId(row.parentNodeId) : null,
    agentId: row.agentId ? fromDbId(row.agentId) : null,
    directReportNodeIds: (row.directReportNodeIds ?? []).map((id) => fromDbId(id)),
    openForHiring: row.openForHiring,
  };
}

export function nodeToInsert(node: ContractNode, companyId: string): NewHierarchyNode {
  return {
    id: toDbId(node.id),
    friendlyId: node.id,
    companyId: toDbId(companyId),
    role: node.role,
    title: node.title,
    level: node.level,
    parentNodeId: node.parentNodeId ? toDbId(node.parentNodeId) : null,
    agentId: node.agentId ? toDbId(node.agentId) : null,
    directReportNodeIds: node.directReportNodeIds.map((id) => toDbId(id)),
    openForHiring: node.openForHiring,
  };
}

// ── Queries ────────────────────────────────────────────────

export async function listByCompany(db: DbClient, companyId: string): Promise<HierarchyNode[]> {
  return db.select().from(hierarchyNodes).where(eq(hierarchyNodes.companyId, toDbId(companyId)));
}

export async function findById(db: DbClient, id: string): Promise<HierarchyNode | null> {
  const [row] = await db.select().from(hierarchyNodes).where(eq(hierarchyNodes.id, toDbId(id))).limit(1);
  return row ?? null;
}

export async function upsertNode(db: DbClient, node: ContractNode, companyId: string): Promise<HierarchyNode> {
  const { id, ...updateFields } = nodeToInsert(node, companyId);
  const [row] = await db
    .insert(hierarchyNodes)
    .values({ id, ...updateFields })
    .onConflictDoUpdate({
      target: hierarchyNodes.id,
      set: { ...updateFields, updatedAt: new Date() },
    })
    .returning();
  return row;
}

/**
 * Bulk-replace the hierarchy for a company in one transaction.
 * Used by `applyStrategy` which rebuilds the org chart on every
 * strategy approval.
 */
export async function replaceForCompany(db: DbClient, companyId: string, nodes: ContractNode[]): Promise<void> {
  const cid = toDbId(companyId);
  await db.transaction(async (tx) => {
    await tx.delete(hierarchyNodes).where(eq(hierarchyNodes.companyId, cid));
    if (nodes.length === 0) return;
    await tx.insert(hierarchyNodes).values(nodes.map((n) => nodeToInsert(n, companyId)));
  });
}
