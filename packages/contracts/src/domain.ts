import { z } from "zod";

export const companyStatusSchema = z.enum(["ideation", "active", "paused", "archived"]);
export const strategyStatusSchema = z.enum(["draft", "pending_board_approval", "approved", "rejected"]);
export const agentStatusSchema = z.enum(["active", "idle", "running", "error", "paused", "terminated"]);
export const sprintStatusSchema = z.enum(["planning", "executing", "reviewing", "completed", "between_sprints", "paused", "cancelled"]);
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
export const artifactKindSchema = z.enum([
  "architecture",
  "specification",
  "implementation",
  "preview",
  "qa_report",
  "launch_asset",
  "meeting_note",
  "chat_card",
  "memory_seed",
  "other"
]);
export const prioritySchema = z.enum(["critical", "high", "medium", "low"]);
export const meetingTypeSchema = z.enum(["standup", "scrum", "escalation", "sync", "handoff", "ad_hoc"]);
export const approvalStatusSchema = z.enum(["pending", "approved", "rejected", "applied"]);
export const roleTypeSchema = z.enum(["ceo", "cto", "pm", "developer", "tester", "ui_designer", "marketing", "skills_lead"]);
export const agendaItemTypeSchema = z.enum(["update", "blocker", "question", "proposal"]);
export const chatMessageRoleSchema = z.enum(["board", "ceo", "agent", "system"]);
export const chatMessageCardTypeSchema = z.enum([
  "welcome_brief",
  "mission_brief",
  "strategy_proposal",
  "clarifying_question",
  "status_update",
  "sprint_proposal",
  "review_summary",
  "approval_request",
  "info"
]);
export const memoryUnitTypeSchema = z.enum(["static", "dynamic", "episodic", "semantic", "delegation"]);
export const memoryVisibilitySchema = z.enum(["public", "team", "private"]);
export const memorySourceSchema = z.enum(["role_seed", "task_completion", "meeting", "chat", "delegation", "system"]);
export const habitStatusSchema = z.enum(["draft", "active", "inactive"]);

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
  currentSprintId: z.string().nullable(),
  currentSprintNumber: z.number().int().positive().nullable(),
  createdAt: z.string()
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
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable()
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
  costCents: z.number().int().nonnegative(),
  iterationCount: z.number().int().nonnegative().default(0),
  maxIterations: z.number().int().positive().default(3),
  incomingArtifactIds: z.array(z.string()).default([]),
  createdAt: z.string().optional(),
  startedAt: z.string().nullable().optional(),
  completedAt: z.string().nullable().optional()
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

export const artifactSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  sprintId: z.string().nullable(),
  taskId: z.string().nullable(),
  agentId: z.string().nullable(),
  kind: artifactKindSchema,
  title: z.string(),
  summary: z.string(),
  location: z.string().nullable(),
  contentType: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string()
});

export const chatMessageSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  sprintId: z.string().nullable(),
  agentId: z.string().nullable(),
  role: chatMessageRoleSchema,
  content: z.string(),
  cardType: chatMessageCardTypeSchema.nullable(),
  cardData: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string()
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

export const memoryUnitSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  agentId: z.string(),
  sourceTaskId: z.string().nullable(),
  sourceArtifactId: z.string().nullable(),
  type: memoryUnitTypeSchema,
  visibility: memoryVisibilitySchema,
  source: memorySourceSchema,
  content: z.string(),
  summary: z.string(),
  confidence: z.number().min(0).max(1),
  tags: z.array(z.string()),
  createdAt: z.string(),
  expiresAt: z.string().nullable()
});

export const habitSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  agentId: z.string(),
  name: z.string(),
  description: z.string(),
  trigger: z.string(),
  action: z.string(),
  status: habitStatusSchema,
  usageCount: z.number().int().nonnegative(),
  successRate: z.number().min(0).max(1),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const primingStateSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  agentId: z.string(),
  confidence: z.number().min(0).max(1),
  caution: z.number().min(0).max(1),
  morale: z.number().min(0).max(1),
  lastDisposition: z.string(),
  recentEvents: z.array(z.string()),
  updatedAt: z.string()
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

export const companySnapshotSchema = z.object({
  company: companySchema,
  idea: fundamentalIdeaSchema,
  strategy: strategyBriefSchema,
  sprints: z.array(sprintSchema),
  hierarchy: z.array(hierarchyNodeSchema),
  agents: z.array(agentIdentitySchema),
  sessions: z.array(sessionBindingSchema),
  tasks: z.array(taskSchema),
  artifacts: z.array(artifactSchema),
  chatMessages: z.array(chatMessageSchema),
  meetings: z.array(meetingSchema),
  approvals: z.array(approvalSchema),
  memories: z.array(memorySummarySchema),
  memoryUnits: z.array(memoryUnitSchema),
  habits: z.array(habitSchema),
  priming: z.array(primingStateSchema),
  transitions: z.array(transitionSchema).default([]),
  feedbackRounds: z.array(feedbackRoundSchema).default([])
});

export type Company = z.infer<typeof companySchema>;
export type FundamentalIdea = z.infer<typeof fundamentalIdeaSchema>;
export type StrategyBrief = z.infer<typeof strategyBriefSchema>;
export type Sprint = z.infer<typeof sprintSchema>;
export type HierarchyNode = z.infer<typeof hierarchyNodeSchema>;
export type RoleSoul = z.infer<typeof roleSoulSchema>;
export type AgentIdentity = z.infer<typeof agentIdentitySchema>;
export type SessionBinding = z.infer<typeof sessionBindingSchema>;
export type Task = z.infer<typeof taskSchema>;
export type AgendaItem = z.infer<typeof agendaItemSchema>;
export type Meeting = z.infer<typeof meetingSchema>;
export type Approval = z.infer<typeof approvalSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type MemorySummary = z.infer<typeof memorySummarySchema>;
export type MemoryUnit = z.infer<typeof memoryUnitSchema>;
export type Habit = z.infer<typeof habitSchema>;
export type PrimingState = z.infer<typeof primingStateSchema>;
export type ExecutionStatus = z.infer<typeof executionStatusSchema>;
export type TransitionStatus = z.infer<typeof transitionStatusSchema>;
export type FeedbackVerdict = z.infer<typeof feedbackVerdictSchema>;
export type Transition = z.infer<typeof transitionSchema>;
export type TransitionProposal = z.infer<typeof transitionProposalSchema>;
export type RouterDecision = z.infer<typeof routerDecisionSchema>;
export type FeedbackRound = z.infer<typeof feedbackRoundSchema>;
export type CompanySnapshot = z.infer<typeof companySnapshotSchema>;
