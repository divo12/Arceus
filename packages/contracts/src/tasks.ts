/**
 * @module tasks
 * Task, transition, and feedback schemas.
 *
 * Tasks are the unit of work — each has a kind (technical_plan, implementation,
 * qa_verification, etc.), an assigned role/agent, and tracks planner/executor/
 * verifier state internally. Tasks form a DAG via dependsOnTaskIds.
 *
 * Transitions record state changes with full audit trail.
 * FeedbackRounds track iterative review loops between roles.
 *
 * Key types:
 * - Task — unit of work with planner/executor/verifier sub-states
 * - Transition — auditable record of task state changes
 * - TransitionProposal — proposed state change with confidence score
 * - RouterDecision — batch of transition proposals from the orchestrator
 * - FeedbackRound — review iteration between two roles
 */
import { z } from "zod";

import { roleTypeSchema } from "./agents";

export const taskStatusSchema = z.enum([
  "created",
  "planned",
  "in_progress",
  "verifying",
  "blocked",
  "completed",
  "failed",
  "cancelled"
]);

export const taskKindSchema = z.enum([
  "technical_plan",
  "acceptance_spec",
  "implementation",
  "local_preview",
  "design_direction",
  "qa_verification",
  "service_validation",
  "launch_content",
  "distribution_campaign",
  "skill_authoring",
  "board_handoff",
  "follow_up",
  "bug_fix"
]);

export const prioritySchema = z.enum(["critical", "high", "medium", "low"]);

export const executionStatusSchema = z.enum([
  "idle",
  "planning",
  "executing",
  "verifying",
  "awaiting_board_review",
  "paused",
  "done",
  "error"
]);

export const transitionStatusSchema = z.enum(["proposed", "accepted", "rejected", "executed", "failed"]);
export const feedbackVerdictSchema = z.enum(["approve", "revise", "escalate"]);

export const plannerStateSchema = z.object({
  objective: z.string(),
  planSteps: z.array(z.string()),
  selectedTools: z.array(z.string()),
  currentStepIndex: z.number().int().nonnegative()
});

/**
 * Per-task living checklist — the agent rewrites it at beat end and reads it on
 * claim so a multi-beat or blocked task resumes instead of restarting. `done`
 * accumulates; `doing`/`next`/`blocked` are the current snapshot. Replaces the
 * append-only `plannerState.planSteps` continuity trail.
 */
export const heartbeatChecklistSchema = z.object({
  done: z.array(z.string()).default([]),
  doing: z.string().nullable().default(null),
  next: z.array(z.string()).default([]),
  blocked: z.string().nullable().default(null),
  updatedAt: z.string().nullable().default(null),
});

export const executorStateSchema = z.object({
  currentCommand: z.string().nullable(),
  commandsExecuted: z.array(z.string()),
  results: z.array(z.string())
});

export const verifierStateSchema = z.object({
  isVerified: z.boolean(),
  feedback: z.string().nullable(),
  verifiedByAgentId: z.string().nullable()
});

export const taskSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  sprintId: z.string().nullable().optional(),
  kind: taskKindSchema,
  title: z.string(),
  description: z.string(),
  problemStatement: z.string(),
  deliverable: z.string(),
  definitionOfDone: z.array(z.string()),
  status: taskStatusSchema,
  priority: prioritySchema,
  sequence: z.number().int().positive().nullable().optional(),
  assignedRole: roleTypeSchema,
  assignedAgentId: z.string().nullable(),
  parentTaskId: z.string().nullable(),
  dependsOnTaskIds: z.array(z.string()),
  childTaskIds: z.array(z.string()),
  artifactIds: z.array(z.string()),
  localPreviewUrl: z.string().nullable(),
  plannerState: plannerStateSchema,
  executorState: executorStateSchema,
  verifierState: verifierStateSchema,
  heartbeat: heartbeatChecklistSchema.default({}),
  costCents: z.number().int().nonnegative(),
  iterationCount: z.number().int().nonnegative().default(0),
  maxIterations: z.number().int().positive().default(3),
  incomingArtifactIds: z.array(z.string()).default([]),
  createdAt: z.string().optional(),
  startedAt: z.string().nullable().optional(),
  completedAt: z.string().nullable().optional()
});

export const transitionSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  fromTaskId: z.string().nullable(),
  toTaskId: z.string(),
  fromStatus: taskStatusSchema.nullable(),
  toStatus: taskStatusSchema,
  triggeredByRole: roleTypeSchema,
  reason: z.string(),
  artifactIds: z.array(z.string()),
  status: transitionStatusSchema,
  executionStatus: executionStatusSchema,
  createdAt: z.string(),
  executedAt: z.string().nullable()
});

export const transitionProposalSchema = z.object({
  fromTaskId: z.string().nullable(),
  toTaskId: z.string(),
  toStatus: taskStatusSchema,
  triggeredByRole: roleTypeSchema,
  reason: z.string(),
  confidence: z.number().min(0).max(1),
  artifactIds: z.array(z.string()),
  requiresApproval: z.boolean()
});

export const routerDecisionSchema = z.object({
  transitions: z.array(transitionProposalSchema).min(1).max(5),
  reasoning: z.string(),
  shouldPause: z.boolean(),
  pauseReason: z.string().nullable(),
  estimatedRemainingSteps: z.number().int().nonnegative()
});

export const feedbackRoundSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  taskId: z.string(),
  iteration: z.number().int().positive(),
  fromRole: roleTypeSchema,
  toRole: roleTypeSchema,
  verdict: feedbackVerdictSchema,
  feedback: z.string(),
  artifactIds: z.array(z.string()),
  createdAt: z.string()
});

export type HeartbeatChecklist = z.infer<typeof heartbeatChecklistSchema>;

/** Canonical empty heartbeat — the single source for task constructors and hydration defaults. */
export function defaultHeartbeat(): HeartbeatChecklist {
  return { done: [], doing: null, next: [], blocked: null, updatedAt: null };
}

export type PlannerState = z.infer<typeof plannerStateSchema>;
export type ExecutorState = z.infer<typeof executorStateSchema>;
export type VerifierState = z.infer<typeof verifierStateSchema>;
export type Task = z.infer<typeof taskSchema>;
export type ExecutionStatus = z.infer<typeof executionStatusSchema>;
export type TransitionStatus = z.infer<typeof transitionStatusSchema>;
export type FeedbackVerdict = z.infer<typeof feedbackVerdictSchema>;
export type Transition = z.infer<typeof transitionSchema>;
export type TransitionProposal = z.infer<typeof transitionProposalSchema>;
export type RouterDecision = z.infer<typeof routerDecisionSchema>;
export type FeedbackRound = z.infer<typeof feedbackRoundSchema>;
