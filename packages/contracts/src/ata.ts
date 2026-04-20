/**
 * @module ata
 * Automated Test & Approve (ATA) pipeline schemas.
 *
 * When a skill mutation is proposed, the ATA pipeline generates test
 * scenarios, runs dry-run simulations, and produces a review verdict
 * (approve/reject/revise). This automates skill quality assurance.
 *
 * Key types:
 * - ATATestScenario — generated test case for a skill mutation
 * - ATADryRunResult — simulation result against a scenario
 * - ATAReviewVerdict — final judgment with security concerns and guidance
 * - ATAPipelineResult — complete pipeline output for a mutation
 */
import { z } from "zod";

// Spec 14 Phase 3: ATA Pipeline types

export const ataTestScenarioSchema = z.object({
  id: z.string(),
  scenario: z.string(),
  taskPrompt: z.string(),
  expectedOutcomes: z.array(z.string()),
  edgeCases: z.array(z.string()),
});

export const ataDryRunResultSchema = z.object({
  testId: z.string(),
  agentPlan: z.string(),
  outcomeMatches: z.array(z.boolean()),
  edgeCaseMatches: z.array(z.boolean()),
  notes: z.string(),
});

export const ataReviewVerdictSchema = z.object({
  verdict: z.enum(["approve", "reject", "revise"]),
  overallScore: z.number().min(0).max(1),
  fixesOriginalFailure: z.boolean(),
  coreOutcomesPassing: z.string(),
  edgeCasesPassing: z.string(),
  securityConcerns: z.array(z.string()),
  revisionGuidance: z.string().nullable(),
});

export const ataPipelineResultSchema = z.object({
  mutationId: z.string(),
  verdict: z.enum(["approve", "reject", "revise"]),
  testScenarios: z.array(ataTestScenarioSchema),
  dryRunResults: z.array(ataDryRunResultSchema),
  reviewVerdict: ataReviewVerdictSchema,
  revisionCycles: z.number().int().min(0),
  completedAt: z.string(),
});

export type ATATestScenario = z.infer<typeof ataTestScenarioSchema>;
export type ATADryRunResult = z.infer<typeof ataDryRunResultSchema>;
export type ATAReviewVerdict = z.infer<typeof ataReviewVerdictSchema>;
export type ATAPipelineResult = z.infer<typeof ataPipelineResultSchema>;
