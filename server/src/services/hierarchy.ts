import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, hierarchyEdges, hierarchySnapshots } from "@paperclipai/db";
import type { HierarchyEdgeType, HierarchyStatus } from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";

interface ProposeInput {
  edges: { sourceAgentId: string; targetAgentId: string; edgeType: HierarchyEdgeType }[];
  description: string;
  proposedByAgentId?: string;
  proposedByUserId?: string;
}

export function hierarchyService(db: Db) {
  async function proposeSnapshot(companyId: string, input: ProposeInput) {
    return db.transaction(async (tx) => {
      const [snapshot] = await tx
        .insert(hierarchySnapshots)
        .values({
          companyId,
          status: "proposed",
          proposedByAgentId: input.proposedByAgentId ?? null,
          proposedByUserId: input.proposedByUserId ?? null,
          description: input.description,
        })
        .returning();

      if (input.edges.length > 0) {
        await tx.insert(hierarchyEdges).values(
          input.edges.map((edge) => ({
            snapshotId: snapshot!.id,
            sourceAgentId: edge.sourceAgentId,
            targetAgentId: edge.targetAgentId,
            edgeType: edge.edgeType,
          })),
        );
      }

      return snapshot!;
    });
  }

  return {
    getById: async (snapshotId: string) => {
      const snapshot = await db
        .select()
        .from(hierarchySnapshots)
        .where(eq(hierarchySnapshots.id, snapshotId))
        .then((rows) => rows[0] ?? null);
      if (!snapshot) throw notFound("Hierarchy snapshot not found");
      return snapshot;
    },

    getCurrentActive: async (companyId: string) => db
      .select()
      .from(hierarchySnapshots)
      .where(and(
        eq(hierarchySnapshots.companyId, companyId),
        eq(hierarchySnapshots.status, "active"),
      ))
      .then((rows) => rows[0] ?? null),

    propose: proposeSnapshot,

    approve: async (snapshotId: string, userId: string) => {
      const existing = await db
        .select()
        .from(hierarchySnapshots)
        .where(eq(hierarchySnapshots.id, snapshotId))
        .then((rows) => rows[0] ?? null);
      if (!existing) throw notFound("Hierarchy snapshot not found");
      if (existing.status !== "proposed") {
        throw unprocessable(`Cannot approve snapshot in "${existing.status}" status`);
      }

      const [updated] = await db
        .update(hierarchySnapshots)
        .set({
          status: "approved",
          approvedByUserId: userId,
          approvedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(hierarchySnapshots.id, snapshotId))
        .returning();
      return updated!;
    },

    activate: async (snapshotId: string) => db.transaction(async (tx) => {
      const snapshot = await tx
        .select()
        .from(hierarchySnapshots)
        .where(eq(hierarchySnapshots.id, snapshotId))
        .then((rows) => rows[0] ?? null);
      if (!snapshot) throw notFound("Hierarchy snapshot not found");
      if (snapshot.status !== "approved") {
        throw unprocessable(`Cannot activate snapshot in "${snapshot.status}" status`);
      }

      const currentActive = await tx
        .select()
        .from(hierarchySnapshots)
        .where(and(
          eq(hierarchySnapshots.companyId, snapshot.companyId),
          eq(hierarchySnapshots.status, "active"),
        ))
        .then((rows) => rows[0] ?? null);

      const now = new Date();
      if (currentActive) {
        await tx
          .update(hierarchySnapshots)
          .set({
            status: "superseded",
            supersededAt: now,
            supersededById: snapshotId,
            updatedAt: now,
          })
          .where(eq(hierarchySnapshots.id, currentActive.id));
      }

      const [activated] = await tx
        .update(hierarchySnapshots)
        .set({
          status: "active",
          approvedAt: snapshot.approvedAt ?? now,
          activatedAt: now,
          updatedAt: now,
        })
        .where(eq(hierarchySnapshots.id, snapshotId))
        .returning();

      await tx
        .update(agents)
        .set({ reportsTo: null, updatedAt: now })
        .where(and(
          eq(agents.companyId, snapshot.companyId),
          eq(agents.kind, "employee"),
        ));

      const reportsToEdges = await tx
        .select()
        .from(hierarchyEdges)
        .where(and(
          eq(hierarchyEdges.snapshotId, snapshotId),
          eq(hierarchyEdges.edgeType, "reports_to"),
        ));

      for (const edge of reportsToEdges) {
        await tx
          .update(agents)
          .set({ reportsTo: edge.targetAgentId, updatedAt: now })
          .where(eq(agents.id, edge.sourceAgentId));
      }

      return activated!;
    }),

    reject: async (snapshotId: string, userId: string, reason: string) => {
      const [updated] = await db
        .update(hierarchySnapshots)
        .set({
          status: "rejected" as HierarchyStatus,
          approvedByUserId: userId,
          description: reason,
          updatedAt: new Date(),
        })
        .where(eq(hierarchySnapshots.id, snapshotId))
        .returning();
      if (!updated) throw notFound("Hierarchy snapshot not found");
      return updated;
    },

    getEdges: async (snapshotId: string, edgeType?: HierarchyEdgeType) => {
      const conditions = [eq(hierarchyEdges.snapshotId, snapshotId)];
      if (edgeType) {
        conditions.push(eq(hierarchyEdges.edgeType, edgeType));
      }
      return db.select().from(hierarchyEdges).where(and(...conditions));
    },

    listProposals: async (companyId: string) => db
      .select()
      .from(hierarchySnapshots)
      .where(eq(hierarchySnapshots.companyId, companyId))
      .orderBy(desc(hierarchySnapshots.createdAt)),

    buildFromCurrentAgents: async (companyId: string) => {
      const companyAgents = await db
        .select({ id: agents.id, reportsTo: agents.reportsTo })
        .from(agents)
        .where(and(
          eq(agents.companyId, companyId),
          eq(agents.kind, "employee"),
        ));

      const edges = companyAgents
        .filter((agent) => agent.reportsTo)
        .map((agent) => ({
          sourceAgentId: agent.id,
          targetAgentId: agent.reportsTo!,
          edgeType: "reports_to" as HierarchyEdgeType,
        }));

      return proposeSnapshot(companyId, {
        edges,
        description: "Auto-materialized from existing agent hierarchy",
        proposedByUserId: "system",
      });
    },

    diffSnapshots: async (currentId: string, targetId: string) => {
      const [currentEdges, targetEdges] = await Promise.all([
        db.select().from(hierarchyEdges).where(eq(hierarchyEdges.snapshotId, currentId)),
        db.select().from(hierarchyEdges).where(eq(hierarchyEdges.snapshotId, targetId)),
      ]);

      const edgeKey = (edge: { sourceAgentId: string; targetAgentId: string; edgeType: string }) =>
        `${edge.sourceAgentId}->${edge.targetAgentId}:${edge.edgeType}`;

      const currentSet = new Set(currentEdges.map(edgeKey));
      const targetSet = new Set(targetEdges.map(edgeKey));

      return {
        added: targetEdges.filter((edge) => !currentSet.has(edgeKey(edge))),
        removed: currentEdges.filter((edge) => !targetSet.has(edgeKey(edge))),
      };
    },
  };
}
