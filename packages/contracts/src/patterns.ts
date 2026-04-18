import { z } from "zod";

// ── Phase 5: Pattern Learning → Skill Formation ──────────

/**
 * A Pattern is a compressed record of a task trajectory, with an embedding that
 * lets us compute similarity to other tasks. Patterns accumulate across sprints
 * and form the raw material for emergent skill discovery.
 */
export const patternOutcomeSchema = z.enum(["success", "failure", "high_friction"]);

export const patternSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  role: z.string(),
  taskTitle: z.string(),
  taskDescription: z.string(),
  summary: z.string().describe("One-line summary of what was attempted + outcome"),
  outcome: patternOutcomeSchema,
  embedding: z.array(z.number()).describe("Vector embedding of the task trajectory"),
  usageCount: z.number().int().nonnegative().describe("How many source tasks have rolled into this pattern"),
  successRate: z.number().min(0).max(1).describe("EMA success across source tasks"),
  sourceTaskIds: z.array(z.string()),
  matchedSkillIds: z.array(z.string()).describe("Skills that were active when this pattern was observed"),
  tags: z.array(z.string()),
  firstSeenSprintId: z.string().nullable().describe("Sprint where this pattern was first observed (Phase 6 cross-sprint transfer)"),
  sprintIds: z.array(z.string()).describe("All sprints where this pattern has been observed"),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * A cluster groups patterns whose embeddings are mutually similar (cosine >= threshold).
 * A cluster with 4+ members, high combined success, and no matching skill becomes
 * a "skill candidate" that can be promoted through the ATA pipeline.
 */
export const patternClusterSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  role: z.string(),
  patternIds: z.array(z.string()).describe("IDs of patterns that form this cluster"),
  representativeTitle: z.string().describe("Short human-readable label"),
  representativeSummary: z.string().describe("Combined behavioral summary across members"),
  combinedUsageCount: z.number().int().nonnegative(),
  combinedSuccessRate: z.number().min(0).max(1),
  dominantRole: z.string(),
  hasMatchingSkill: z.boolean(),
  matchingSkillId: z.string().nullable(),
  createdAt: z.string(),
});

/**
 * A candidate is a cluster that satisfies the promotion criteria.
 * It carries the minimum data needed for an LLM to synthesize a SKILL.md.
 */
export const skillCandidateSchema = z.object({
  clusterId: z.string(),
  companyId: z.string(),
  role: z.string(),
  representativeTitle: z.string(),
  representativeSummary: z.string(),
  memberCount: z.number().int().nonnegative(),
  combinedUsageCount: z.number().int().nonnegative(),
  combinedSuccessRate: z.number().min(0).max(1),
  memberSummaries: z.array(z.string()).describe("Summaries of cluster members for LLM context"),
  proposedAt: z.string(),
});

export type PatternOutcome = z.infer<typeof patternOutcomeSchema>;
export type Pattern = z.infer<typeof patternSchema>;
export type PatternCluster = z.infer<typeof patternClusterSchema>;
export type SkillCandidate = z.infer<typeof skillCandidateSchema>;
