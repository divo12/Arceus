/**
 * @module skills
 * Skill artifact, mutation, and health-report schemas.
 *
 * Skills are reusable prompt-templates that agents apply to tasks.
 * They go through a lifecycle: draft → testing → active → deprecated.
 * Skills can be mutated (improved) via the ATA pipeline when failures
 * are attributed to them.
 *
 * Key types:
 * - SkillArtifact — a versioned skill with trigger, content, test cases, and success rate
 * - SkillMutation — a proposed improvement to a skill with test results
 * - FailureAttribution — links a task failure to a specific skill
 * - SkillHealthReport — aggregate metrics across all skills
 */
import { z } from "zod";

export const skillStatusSchema = z.enum(["draft", "testing", "active", "deprecated"]);

export const skillTestCaseSchema = z.object({
  id: z.string(),
  description: z.string(),
  input: z.string(),
  expectedBehavior: z.string(),
  validationCriteria: z.array(z.string()),
});

export const skillArtifactSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  name: z.string(),
  role: z.string(),
  version: z.number().int().min(1).default(1),
  status: skillStatusSchema,
  trigger: z.string(),
  content: z.string(),
  testCases: z.array(skillTestCaseSchema).default([]),
  successRate: z.number().min(0).max(1).default(0.5),
  usageCount: z.number().int().default(0),
  lastUsedAt: z.string().nullable().default(null),
  mutatedFromId: z.string().nullable().default(null),
  mutatedBy: z.string().nullable().default(null),
  mutationReason: z.string().nullable().default(null),
  createdAt: z.string(),
  approvedAt: z.string().nullable().default(null),
  /** @deprecated No longer populated. Kept optional so legacy records still
   *  parse. Skill matching is now handled by an LLM classifier in the
   *  orchestrator (see buildSkillCatalog / classifyTaskSkills); trigger
   *  embeddings are no longer needed. */
  triggerEmbedding: z.array(z.number()).optional(),
});

export const skillHealthReportSchema = z.object({
  totalSkills: z.number(),
  activeSkills: z.number(),
  averageSuccessRate: z.number(),
  worstPerformers: z.array(z.object({
    skillId: z.string(),
    name: z.string(),
    successRate: z.number(),
    issues: z.array(z.string()),
  })),
  gaps: z.array(z.object({
    taskPattern: z.string(),
    frequency: z.number(),
    suggestedSkill: z.string(),
  })),
  recentMutationCount: z.number(),
});

// Spec 14 Phase 2: Failure Attribution + Skill Mutation

export const failureAttributionSchema = z.object({
  taskId: z.string(),
  outcome: z.enum(["failed", "high_friction", "success"]),
  attributedSkillId: z.string().nullable(),
  failureMode: z.string(),
  confidence: z.number().min(0).max(1),
  suggestedFix: z.string(),
  isSkillGap: z.boolean(),
  createdAt: z.string(),
});

export const skillMutationStatusSchema = z.enum([
  "proposed", "testing", "approved", "rejected", "revision", "merged",
]);

export const skillTestResultSchema = z.object({
  testCaseId: z.string(),
  status: z.enum(["pass", "fail", "error"]),
  output: z.string(),
  durationMs: z.number(),
  executedAt: z.string(),
});

export const skillMutationSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  originalSkillId: z.string().nullable(),
  proposedSkill: skillArtifactSchema,
  reason: z.string(),
  failureTraceId: z.string().nullable(),
  status: skillMutationStatusSchema,
  revisionCycle: z.number().int().min(0).default(0),
  testResults: z.array(skillTestResultSchema).default([]),
  reviewFeedback: z.string().nullable().default(null),
  proposedBy: z.string(),
  proposedAt: z.string(),
  resolvedAt: z.string().nullable().default(null),
});

export type SkillStatus = z.infer<typeof skillStatusSchema>;
export type SkillTestCase = z.infer<typeof skillTestCaseSchema>;
export type SkillArtifact = z.infer<typeof skillArtifactSchema>;
export type SkillHealthReport = z.infer<typeof skillHealthReportSchema>;
export type FailureAttribution = z.infer<typeof failureAttributionSchema>;
export type SkillMutation = z.infer<typeof skillMutationSchema>;
export type SkillMutationStatus = z.infer<typeof skillMutationStatusSchema>;
export type SkillTestResult = z.infer<typeof skillTestResultSchema>;
