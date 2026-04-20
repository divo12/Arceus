/**
 * @module meetings
 * Meeting lifecycle, contribution, synthesis, and resolution schemas.
 *
 * Meetings follow a pipeline: scheduled → collecting (agents submit contributions)
 * → synthesizing (LLM identifies conflicts/blockers) → resolving (decisions made)
 * → executing (actions applied) → learning → completed.
 *
 * Key types:
 * - MeetingContribution — an agent's standup update (what I did, blockers, learnings)
 * - SynthesisOutput — LLM-detected conflicts, blockers, and highlights
 * - ResolutionDecision — action taken per conflict/blocker (create_task, escalate, etc.)
 * - DailySyncBrief — summary posted to the board chat
 * - MeetingHealthSnapshot — telemetry for the meeting pipeline
 */
import { z } from "zod";

export const meetingTypeSchema = z.enum(["daily_sync", "eval_triggered", "escalation"]);
export const meetingStatusSchema = z.enum(["scheduled", "collecting", "synthesizing", "resolving", "executing", "learning", "completed", "skipped"]);

export const meetingContributionSchema = z.object({
  agentId: z.string(),
  agentName: z.string(),
  agentRole: z.string(),
  contribution: z.object({
    whatIDid: z.string(),
    whatImDoing: z.string(),
    blockers: z.string(),
    learnings: z.string(),
    questionsForTeam: z.string(),
  }),
  submittedAt: z.string(),
});

export const meetingSynthesisConflictSchema = z.object({
  id: z.string(),
  description: z.string(),
  involvedAgentIds: z.array(z.string()),
  severity: z.enum(["low", "medium", "high"]),
  suggestedResolution: z.string(),
});

export const meetingSynthesisBlockerSchema = z.object({
  id: z.string(),
  description: z.string(),
  reportedByAgentId: z.string(),
  suggestedAction: z.string(),
});

export const synthesisOutputSchema = z.object({
  conflicts: z.array(meetingSynthesisConflictSchema),
  blockers: z.array(meetingSynthesisBlockerSchema),
  alignmentIssues: z.array(z.object({
    id: z.string(),
    description: z.string(),
    involvedAgentIds: z.array(z.string()),
  })),
  highlights: z.array(z.object({
    type: z.enum(["completion", "milestone", "risk"]),
    description: z.string(),
    agentId: z.string(),
  })),
  requiresBoardAttention: z.boolean(),
  boardSummary: z.string().nullable(),
});

export const resolutionDecisionSchema = z.object({
  conflictId: z.string().nullable(),
  blockerId: z.string().nullable(),
  decision: z.string(),
  action: z.enum(["create_task", "modify_task", "escalate_to_board", "note", "no_action"]),
  taskAction: z.object({
    type: z.enum(["create", "update", "reassign"]),
    title: z.string().optional(),
    description: z.string().optional(),
    assigneeRole: z.string().optional(),
    issueId: z.string().optional(),
    newStatus: z.string().optional(),
    newPriority: z.string().optional(),
  }).optional(),
  escalation: z.object({
    question: z.string(),
    context: z.string(),
    severity: z.enum(["low", "medium", "high"]),
  }).optional(),
});

export const resolutionOutputSchema = z.object({
  decisions: z.array(resolutionDecisionSchema),
});

export const dailySyncBriefSchema = z.object({
  date: z.string(),
  companyStatus: z.string(),
  teamUpdates: z.array(z.object({
    agentRole: z.string(),
    summary: z.string(),
  })),
  activeBlockers: z.array(z.string()),
  upcomingDependencies: z.array(z.string()),
  decisionsFromMeeting: z.array(z.string()),
});

export const meetingHealthSnapshotSchema = z.object({
  meetingId: z.string(),
  scheduleId: z.string().nullable(),
  pipelineDurationMs: z.number().int().nonnegative(),
  contributionCount: z.number().int().nonnegative(),
  conflictCount: z.number().int().nonnegative().default(0),
  blockerCount: z.number().int().nonnegative().default(0),
  decisionsCount: z.number().int().nonnegative().default(0),
  tasksCreated: z.number().int().nonnegative().default(0),
  tasksModified: z.number().int().nonnegative().default(0),
  escalationsCreated: z.number().int().nonnegative().default(0),
  totalTokensUsed: z.number().int().nonnegative().default(0),
  skippedBefore: z.number().int().nonnegative().default(0),
});

export const meetingScheduleConfigSchema = z.object({
  maxConsecutiveSkips: z.number().int().positive().default(3),
  skipIfNoBlockers: z.boolean().default(true),
  skipIfNoTaskChanges: z.boolean().default(true),
  collectionTimeoutMs: z.number().int().positive().default(300000),
});

export const meetingScheduleSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  type: meetingTypeSchema,
  title: z.string(),
  intervalMs: z.number().int().positive(),
  participantAgentIds: z.array(z.string()),
  facilitatorAgentId: z.string(),
  conditionalCheckEnabled: z.boolean(),
  enabled: z.boolean(),
  lastCheckedAt: z.string().nullable(),
  lastMeetingId: z.string().nullable(),
  nextCheckAt: z.string().nullable(),
  skipCount: z.number().int().nonnegative().default(0),
  totalRuns: z.number().int().nonnegative().default(0),
  config: meetingScheduleConfigSchema,
});

export const meetingSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  scheduleId: z.string().nullable(),
  type: meetingTypeSchema,
  title: z.string(),
  status: meetingStatusSchema,
  facilitatorAgentId: z.string(),
  participantAgentIds: z.array(z.string()),
  contributions: z.array(meetingContributionSchema),
  synthesis: synthesisOutputSchema.nullable(),
  resolutions: resolutionOutputSchema.nullable(),
  brief: dailySyncBriefSchema.nullable(),
  healthSnapshot: meetingHealthSnapshotSchema.nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});

export type MeetingContribution = z.infer<typeof meetingContributionSchema>;
export type SynthesisOutput = z.infer<typeof synthesisOutputSchema>;
export type ResolutionOutput = z.infer<typeof resolutionOutputSchema>;
export type ResolutionDecision = z.infer<typeof resolutionDecisionSchema>;
export type DailySyncBrief = z.infer<typeof dailySyncBriefSchema>;
export type MeetingHealthSnapshot = z.infer<typeof meetingHealthSnapshotSchema>;
export type MeetingScheduleConfig = z.infer<typeof meetingScheduleConfigSchema>;
export type MeetingSchedule = z.infer<typeof meetingScheduleSchema>;
export type Meeting = z.infer<typeof meetingSchema>;
