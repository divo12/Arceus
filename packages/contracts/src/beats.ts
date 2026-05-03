/**
 * @module beats
 * Heartbeat scheduling engine schemas (Spec 12).
 *
 * Beats are the fundamental execution unit — each agent gets periodic heartbeats
 * (interval-triggered) or event-triggered beats. A beat goes through phases:
 * contextAssembly → observation (checklist checks) → execution (LLM + tools)
 * → serialization (state mutations).
 *
 * Key types:
 * - BeatRecord — full record of one heartbeat cycle with timing and cost
 * - BeatTrigger — interval or event-based trigger
 * - BeatOutcome — result enum (HEARTBEAT_OK, WORK_DONE, ERROR, etc.)
 * - TaskProgress / TaskResult — per-task progress tracking within beats
 */
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

/**
 * Audit C11 (F-249, F-251, F-275, F-276, F-286): typed discriminator for
 * machine-routed checklist actions. Replaces the previous colon-string
 * convention (e.g. `"sprint_review:cto_escalation_review"`,
 * `"meeting_contribution:<meetingId>"`) which checklist-executor.ts had
 * to parse via `startsWith` / `split(":")`. Producers now set this when
 * the action is meant for the dispatch table; `suggestedAction` is
 * reserved for human-readable display text.
 *
 * If you add a new kind here:
 *   1. add a producer site in `heartbeat-checklist.ts` that sets it
 *   2. add a `case` arm in `checklist-executor.ts` switch — exhaustiveness
 *      check fails the build until you do.
 */
export const checklistDispatchSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("sprint_review.run_tester_verification") }),
  z.object({ kind: z.literal("sprint_review.run_final_gate") }),
  z.object({ kind: z.literal("sprint_review.retest_after_rework") }),
  z.object({ kind: z.literal("sprint_review.cto_escalation_review") }),
  z.object({ kind: z.literal("sprint_review.cto_escalation_force_complete") }),
  z.object({ kind: z.literal("skills_lead.mutate_underperformer") }),
  z.object({ kind: z.literal("skills_lead.deprecate_unused") }),
  z.object({ kind: z.literal("skills_lead.fill_skill_gap") }),
  z.object({ kind: z.literal("meeting_contribution"), meetingId: z.string() }),
  z.object({ kind: z.literal("task_resolve_blocker"), taskId: z.string() }),
]);

export type ChecklistDispatch = z.infer<typeof checklistDispatchSchema>;
export type ChecklistDispatchKind = ChecklistDispatch["kind"];

export const checkResultSchema = z.object({
  status: z.enum(["ok", "action_needed", "blocked"]),
  detail: z.string().optional(),
  /** Human-readable display text. Free-form; do NOT parse. */
  suggestedAction: z.string().optional(),
  /** Machine-routed action — checked by checklist-executor.ts. */
  dispatch: checklistDispatchSchema.optional(),
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
