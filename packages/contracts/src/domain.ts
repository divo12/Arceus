import { z } from "zod";

export const companyStatusSchema = z.enum(["ideation", "active", "paused", "archived"]);
export const strategyStatusSchema = z.enum(["draft", "pending_board_approval", "approved", "rejected"]);
export const agentStatusSchema = z.enum(["active", "idle", "running", "error", "paused", "terminated"]);
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
  "follow_up"
]);
export const prioritySchema = z.enum(["critical", "high", "medium", "low"]);
export const meetingTypeSchema = z.enum(["standup", "scrum", "escalation", "sync", "handoff", "ad_hoc"]);
export const approvalStatusSchema = z.enum(["pending", "approved", "rejected", "applied"]);
export const roleTypeSchema = z.enum(["ceo", "cto", "pm", "developer", "tester", "ui_designer", "marketing", "skills_lead"]);
export const agendaItemTypeSchema = z.enum(["update", "blocker", "question", "proposal"]);

export const roleSoulSchema = z.object({
  role: roleTypeSchema,
  purpose: z.string(),
  systemPrompt: z.string(),
  canWriteCode: z.boolean(),
  canEditFiles: z.boolean(),
  canRunShell: z.boolean(),
  canApproveStrategy: z.boolean(),
  canRequestHiring: z.boolean(),
  allowedDirectReports: z.array(roleTypeSchema),
  defaultCapabilities: z.array(z.string())
});

export const companySchema = z.object({
  id: z.string(),
  name: z.string(),
  boardOwner: z.string(),
  goal: z.string(),
  budgetCents: z.number().int().nonnegative(),
  spentCents: z.number().int().nonnegative(),
  status: companyStatusSchema,
  currentStrategyId: z.string(),
  createdAt: z.string()
});

export const fundamentalIdeaSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  coreIdea: z.string(),
  currentDirection: z.string(),
  refinedWithBoard: z.boolean()
});

export const strategyBriefSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  title: z.string(),
  summary: z.string(),
  firstRelease: z.string(),
  scopeBoundary: z.array(z.string()),
  roleRationale: z.array(z.string()),
  status: strategyStatusSchema,
  createdByAgentId: z.string(),
  createdAt: z.string()
});

export const hierarchyNodeSchema = z.object({
  id: z.string(),
  role: roleTypeSchema,
  title: z.string(),
  level: z.number().int().nonnegative(),
  parentNodeId: z.string().nullable(),
  agentId: z.string().nullable(),
  directReportNodeIds: z.array(z.string()),
  openForHiring: z.boolean()
});

export const agentIdentitySchema = z.object({
  id: z.string(),
  companyId: z.string(),
  nodeId: z.string(),
  name: z.string(),
  role: roleTypeSchema,
  title: z.string(),
  managerAgentId: z.string().nullable(),
  reportAgentIds: z.array(z.string()),
  capabilities: z.array(z.string()),
  profile: z.string(),
  soul: roleSoulSchema,
  status: agentStatusSchema,
  sessionBindingId: z.string(),
  memorySummaryId: z.string(),
  lastHeartbeatAt: z.string().nullable()
});

export const sessionBindingSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  runtime: z.literal("opencode"),
  sessionId: z.string(),
  runtimeStatus: z.enum(["connected", "idle", "disconnected"]),
  model: z.string(),
  lastSeenAt: z.string()
});

export const plannerStateSchema = z.object({
  objective: z.string(),
  planSteps: z.array(z.string()),
  selectedTools: z.array(z.string()),
  currentStepIndex: z.number().int().nonnegative()
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
  kind: taskKindSchema,
  title: z.string(),
  description: z.string(),
  problemStatement: z.string(),
  deliverable: z.string(),
  definitionOfDone: z.array(z.string()),
  status: taskStatusSchema,
  priority: prioritySchema,
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
  costCents: z.number().int().nonnegative()
});

export const agendaItemSchema = z.object({
  id: z.string(),
  topic: z.string(),
  type: agendaItemTypeSchema,
  content: z.string(),
  raisedByAgentId: z.string(),
  relatedTaskId: z.string().nullable(),
  needsBoardApproval: z.boolean()
});

export const meetingDecisionSchema = z.object({
  id: z.string(),
  description: z.string(),
  decidedByAgentIds: z.array(z.string()),
  impactIds: z.array(z.string())
});

export const meetingLearningSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  content: z.string(),
  promotedToSummary: z.boolean()
});

export const taskModificationSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  modificationType: z.enum(["assign", "reprioritize", "reassign", "cancel", "decompose_further", "unblock"]),
  details: z.string(),
  assignedRole: roleTypeSchema.nullable().optional(),
  priority: prioritySchema.nullable().optional(),
  resultingStatus: taskStatusSchema.nullable().optional(),
});

export const memoryModificationSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  modificationType: z.enum(["current_focus", "recent_learning", "active_pattern", "open_blocker", "important_decision", "clear_blocker"]),
  content: z.string(),
});

export const meetingSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  type: meetingTypeSchema,
  participants: z.array(z.string()),
  agenda: z.array(agendaItemSchema),
  decisions: z.array(meetingDecisionSchema),
  learnings: z.array(meetingLearningSchema),
  taskModifications: z.array(taskModificationSchema),
  memoryModifications: z.array(memoryModificationSchema),
  status: z.enum(["scheduled", "in_progress", "completed"]),
  summary: z.string(),
  scheduledAt: z.string(),
  completedAt: z.string().nullable()
});

export const approvalSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  type: z.enum(["strategy", "hire", "meeting_blocker", "external_action"]),
  status: approvalStatusSchema,
  title: z.string(),
  description: z.string(),
  requestedByAgentId: z.string(),
  meetingId: z.string().nullable(),
  agendaItemId: z.string().nullable(),
  resolutionSummary: z.string().nullable()
});

export const memorySummarySchema = z.object({
  id: z.string(),
  agentId: z.string(),
  currentFocus: z.array(z.string()),
  recentLearnings: z.array(z.string()),
  activePatterns: z.array(z.string()),
  openBlockers: z.array(z.string()),
  importantDecisions: z.array(z.string()),
  updatedAt: z.string()
});

export const companySnapshotSchema = z.object({
  company: companySchema,
  idea: fundamentalIdeaSchema,
  strategy: strategyBriefSchema,
  hierarchy: z.array(hierarchyNodeSchema),
  agents: z.array(agentIdentitySchema),
  sessions: z.array(sessionBindingSchema),
  tasks: z.array(taskSchema),
  meetings: z.array(meetingSchema),
  approvals: z.array(approvalSchema),
  memories: z.array(memorySummarySchema)
});

export type Company = z.infer<typeof companySchema>;
export type FundamentalIdea = z.infer<typeof fundamentalIdeaSchema>;
export type StrategyBrief = z.infer<typeof strategyBriefSchema>;
export type HierarchyNode = z.infer<typeof hierarchyNodeSchema>;
export type RoleSoul = z.infer<typeof roleSoulSchema>;
export type AgentIdentity = z.infer<typeof agentIdentitySchema>;
export type SessionBinding = z.infer<typeof sessionBindingSchema>;
export type Task = z.infer<typeof taskSchema>;
export type AgendaItem = z.infer<typeof agendaItemSchema>;
export type Meeting = z.infer<typeof meetingSchema>;
export type Approval = z.infer<typeof approvalSchema>;
export type MemorySummary = z.infer<typeof memorySummarySchema>;
export type CompanySnapshot = z.infer<typeof companySnapshotSchema>;
