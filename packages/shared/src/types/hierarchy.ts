import type { HierarchyEdgeType, HierarchyStatus } from "../constants.js";

export interface HierarchyEdge {
  id: string;
  snapshotId: string;
  sourceAgentId: string;
  targetAgentId: string;
  edgeType: HierarchyEdgeType;
  metadata?: Record<string, unknown> | null;
  createdAt?: Date;
}

export interface HierarchySnapshot {
  id: string;
  companyId: string;
  status: HierarchyStatus;
  proposedByAgentId: string | null;
  proposedByUserId: string | null;
  approvedByUserId: string | null;
  description: string | null;
  edges: HierarchyEdge[];
  createdAt: Date;
  updatedAt?: Date;
  approvedAt?: Date | null;
  activatedAt?: Date | null;
  supersededAt?: Date | null;
  supersededById?: string | null;
}
