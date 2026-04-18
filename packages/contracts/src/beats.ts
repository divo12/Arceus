import { z } from "zod";

import { roleTypeSchema, roleSoulSchema, hierarchyNodeSchema } from "./agents";
import { companySchema } from "./company";
import { sprintSchema } from "./sprints";
import { taskSchema } from "./tasks";
import { artifactSchema } from "./artifacts";
import { approvalSchema } from "./approvals";
import { chatMessageSchema } from "./chat";
import { meetingSchema, dailySyncBriefSchema } from "./meetings";

// ── Heartbeat Scheduling Engine (Spec 12) ──────────────────

export const beatOutcomeSchema = z.enum([
  "HEARTBEAT_OK",      // idle — nothing needed
  "WORK_DONE",         // agent executed work successfully
  "ERROR",             // beat failed with an error
  "TIMED_OUT",         // beat exceeded timeout
  "BUDGET_EXCEEDED",   // token/cost budget exhausted
  "CONFLICT",          // optimistic concurrency conflict
  "SKIPPED",           // beat skipped (paused role, no active sprint, etc.)
]);

export const beatEventTriggerSchema = z.enum([
  "task_assigned",
  "task_dependency_met",
  "board_message",
  "approval_granted",
  "feedback_received",
  "sprint_started",
  "sprint_completed",
  "escalation_received",
  "bug_reported",
  "meeting_contribution",
]);

export const beatTriggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("interval"), scheduledAt: z.string() }),
  z.object({ type: z.literal("event"), event: beatEventTriggerSchema }),
]);

export const beatStatusSchema = z.enum(["running", "completed", "failed", "skipped", "timed_out"]);

export const checkResultSchema = z.object({
  status: z.enum(["ok", "action_needed", "blocked"]),
  detail: z.string().optional(),
  suggestedAction: z.string().optional(),
});

export const beatPhaseTimingSchema = z.object({
  durationMs: z.number().int().nonnegative(),
  tokensUsed: z.number().int().nonnegative(),
});

export const beatPhasesSchema = z.object({
  contextAssembly: beatPhaseTimingSchema.optional(),
  observation: beatPhaseTimingSchema.extend({
    checkResults: z.array(checkResultSchema),
  }).optional(),
  execution: beatPhaseTimingSchema.extend({
    toolCalls: z.number().int().nonnegative(),
    actionsCount: z.number().int().nonnegative(),
  }).optional(),
  serialization: z.object({
    durationMs: z.number().int().nonnegative(),
    mutationCount: z.number().int().nonnegative(),
  }).optional(),
});

export const beatRecordSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  agentId: z.string().nullable(),
  beatNumber: z.number().int().nonnegative(),
  trigger: beatTriggerSchema,
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  status: beatStatusSchema,
  snapshotVersionRead: z.number().int().nullable(),
  snapshotVersionWritten: z.number().int().nullable(),
  phases: beatPhasesSchema,
  outcome: beatOutcomeSchema.nullable(),
  totalTokens: z.number().int().nonnegative(),
  costCents: z.number().nonnegative(),
  errorMessage: z.string().nullable(),
  summary: z.string().nullable(),
});

export const taskProgressSchema = z.object({
  taskId: z.string(),
  totalSteps: z.number().int().positive().nullable(),
  completedSteps: z.number().int().nonnegative(),
  currentStepDescription: z.string(),
  lastBeatId: z.string(),
  filesModified: z.array(z.string()),
  notes: z.string(),
});

export const taskResultSchema = z.object({
  summary: z.string(),
  artifacts: z.array(z.string()),
  filesModified: z.array(z.string()),
  tokensUsed: z.number().int().nonnegative(),
  beatId: z.string(),
});

export const agentBeatContextSchema = z.object({
  // Beat metadata
  beatId: z.string(),
  beatNumber: z.number().int().nonnegative(),
  trigger: beatTriggerSchema,
  startedAt: z.string(),

  // Agent identity (from SOUL)
  agentId: z.string(),
  agentName: z.string(),
  role: roleTypeSchema,
  soul: roleSoulSchema,

  // Company state (from Control Plane)
  company: companySchema,
  currentSprint: sprintSchema.nullable(),

  // Hierarchy context
  hierarchy: z.array(hierarchyNodeSchema),
  managerAgentId: z.string().nullable(),
  reportAgentIds: z.array(z.string()),

  // This agent's tasks (from current sprint)
  tasks: z.array(taskSchema),
  taskProgress: z.array(taskProgressSchema),

  // Upstream artifacts relevant to this agent's tasks
  artifacts: z.array(artifactSchema),

  // Memory context (from Hippocampus)
  memories: z.array(z.string()),
  habits: z.array(z.string()),
  priming: z.string(),

  // Governance context
  availableTools: z.array(z.string()),
  trustFactor: z.number().min(0).max(1),

  // Environment
  approvals: z.array(approvalSchema),
  recentBoardMessages: z.array(chatMessageSchema),
  recentMeetings: z.array(meetingSchema),
  latestDailySyncBrief: dailySyncBriefSchema.nullable().default(null),

  // Budget constraints
  beatTokenBudget: z.number().int().positive(),
  beatCostCeilingCents: z.number().nonnegative(),
  companyBudgetRemainingCents: z.number().int(),

  // Build status injected by API layer (for checkBuildStatus checklist item)
  lastBuildCheck: z.object({
    status: z.enum(["ok", "error", "unknown"]),
    detail: z.string(),
    checkedAt: z.string(),
  }).optional(),

  // Spec 14 Phase 6 — Skills Lead proactive heartbeat context
  skillHealth: z.object({
    totalSkills: z.number().int().nonnegative(),
    activeSkills: z.number().int().nonnegative(),
    averageSuccessRate: z.number().min(0).max(1),
    worstPerformers: z.array(z.object({
      skillId: z.string(),
      name: z.string(),
      successRate: z.number().min(0).max(1),
    })),
  }).optional(),
  unusedSkills: z.array(z.object({
    skillId: z.string(),
    name: z.string(),
    lastUsedAt: z.string().nullable(),
  })).optional(),
  sprintSkillGapCount: z.number().int().nonnegative().optional(),
});

// Heartbeat types (Spec 12)
export type BeatOutcome = z.infer<typeof beatOutcomeSchema>;
export type BeatEventTrigger = z.infer<typeof beatEventTriggerSchema>;
export type BeatTrigger = z.infer<typeof beatTriggerSchema>;
export type BeatStatus = z.infer<typeof beatStatusSchema>;
export type CheckResult = z.infer<typeof checkResultSchema>;
export type BeatPhaseTiming = z.infer<typeof beatPhaseTimingSchema>;
export type BeatPhases = z.infer<typeof beatPhasesSchema>;
export type BeatRecord = z.infer<typeof beatRecordSchema>;
export type TaskProgress = z.infer<typeof taskProgressSchema>;
export type TaskResult = z.infer<typeof taskResultSchema>;
export type AgentBeatContext = z.infer<typeof agentBeatContextSchema>;
