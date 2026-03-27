import { z } from "zod";
import { HIERARCHY_EDGE_TYPES } from "../constants.js";

export const proposeHierarchyChangeSchema = z.object({
  edges: z.array(z.object({
    sourceAgentId: z.string().uuid(),
    targetAgentId: z.string().uuid(),
    edgeType: z.enum(HIERARCHY_EDGE_TYPES),
  })).min(1, "At least one edge is required"),
  description: z.string().min(1).max(2000),
});

export const resolveHierarchyProposalSchema = z.object({
  reason: z.string().min(1).max(2000),
});

export type ProposeHierarchyChange = z.infer<typeof proposeHierarchyChangeSchema>;
export type ResolveHierarchyProposal = z.infer<typeof resolveHierarchyProposalSchema>;
