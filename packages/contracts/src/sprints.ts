import { z } from "zod";

export const sprintStatusSchema = z.enum(["planning", "executing", "reviewing", "completed", "between_sprints", "paused", "cancelled"]);

export const sprintReviewPhaseSchema = z.enum([
  "pre_gate",
  "tester_verification",
  "rework",
  "final_gate",
  "complete",
  "escalated",
]);

export const sprintReviewStateSchema = z.object({
  phase: sprintReviewPhaseSchema,
  gateResults: z.array(z.lazy(() => verificationGateResultSchema)),
  bugTaskIds: z.array(z.string()),
  reworkCycleCount: z.number().int().nonnegative(),
  maxReworkCycles: z.number().int().positive().default(3),
  testerVerdict: z.enum(["pending", "pass", "fail"]).nullable(),
  escalatedToCto: z.boolean(),
  ctoDecision: z.enum(["fix", "skip", "abort"]).nullable(),
  /** ISO timestamp set when escalatedToCto first flips to true. Used by the
   * force-complete safety valve to bound how long CTO review can stall. */
  escalatedAt: z.string().nullable().default(null),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
});

export const sprintSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  strategyId: z.string().nullable(),
  number: z.number().int().positive(),
  title: z.string(),
  goal: z.string(),
  status: sprintStatusSchema,
  plannedByAgentId: z.string().nullable(),
  summary: z.string().nullable(),
  reviewState: z.lazy(() => sprintReviewStateSchema).nullable().optional(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable()
});

export const verificationGateResultSchema = z.object({
  passed: z.boolean(),
  buildResult: z.object({
    exitCode: z.number(),
    stdout: z.string(),
    stderr: z.string(),
  }).nullable(),
  testResult: z.object({
    exitCode: z.number(),
    stdout: z.string(),
    stderr: z.string(),
    summary: z.string(),
  }).nullable(),
  previewResult: z.object({
    reachable: z.boolean(),
    statusCode: z.number().nullable(),
    error: z.string().nullable(),
  }).nullable().optional(),
  phase: z.enum(["pre_review", "final"]),
  timestamp: z.string(),
});

export const defectAreaSchema = z.enum([
  "build_failure",
  "test_failure",
  "ui_rendering",
  "ui_interaction",
  "api_behavior",
  "accessibility",
  "content",
  "design_mismatch",
  "logic_error",
  "performance",
]);

export type Sprint = z.infer<typeof sprintSchema>;
export type VerificationGateResult = z.infer<typeof verificationGateResultSchema>;
export type SprintReviewPhase = z.infer<typeof sprintReviewPhaseSchema>;
export type SprintReviewState = z.infer<typeof sprintReviewStateSchema>;
export type DefectArea = z.infer<typeof defectAreaSchema>;
