import type { HierarchyEdge, HierarchyEdgeType, HierarchySnapshot } from "@paperclipai/shared";
import { api } from "./client";

export interface HierarchySnapshotWithEdges extends HierarchySnapshot {
  edges: HierarchyEdge[];
}

export interface HierarchyDiff {
  added: HierarchyEdge[];
  removed: HierarchyEdge[];
}

export interface HierarchyProposalInput {
  edges: Array<{
    sourceAgentId: string;
    targetAgentId: string;
    edgeType: HierarchyEdgeType;
  }>;
  description: string;
}

export const hierarchyApi = {
  getActive: (companyId: string) =>
    api.get<HierarchySnapshotWithEdges | null>(
      `/companies/${encodeURIComponent(companyId)}/hierarchy`,
    ),
  listProposals: (companyId: string) =>
    api.get<HierarchySnapshot[]>(
      `/companies/${encodeURIComponent(companyId)}/hierarchy/proposals`,
    ),
  createProposal: (companyId: string, data: HierarchyProposalInput) =>
    api.post<HierarchySnapshot>(
      `/companies/${encodeURIComponent(companyId)}/hierarchy/proposals`,
      data,
    ),
  getSnapshot: (id: string) =>
    api.get<HierarchySnapshotWithEdges>(`/hierarchy/${encodeURIComponent(id)}`),
  diff: (id: string) =>
    api.get<HierarchyDiff>(`/hierarchy/${encodeURIComponent(id)}/diff`),
  approve: (id: string) =>
    api.post<HierarchySnapshot>(`/hierarchy/${encodeURIComponent(id)}/approve`, {}),
  activate: (id: string) =>
    api.post<HierarchySnapshot>(`/hierarchy/${encodeURIComponent(id)}/activate`, {}),
  reject: (id: string, reason: string) =>
    api.post<HierarchySnapshot>(`/hierarchy/${encodeURIComponent(id)}/reject`, { reason }),
};
