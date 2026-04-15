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
  "follow_up",
  "bug_fix"
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
  "plan",
  "output",
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
  reviewState: z.lazy(() => sprintReviewStateSchema).nullable().optional(),
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
  type: z.enum(["strategy", "hire", "meeting_blocker", "external_action", "tool_governance"]),
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

export const workspaceStatusSchema = z.enum(["active", "archived", "restoring"]);
export const sprintSnapshotStatusSchema = z.enum(["active", "rolled_back"]);

export const workspaceInfoSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  localPath: z.string().nullable(),
  status: workspaceStatusSchema,
  latestBundleKey: z.string().nullable(),
  latestBundleSha256: z.string().nullable(),
  latestBundleBytes: z.number().int().nonnegative().nullable(),
  currentSprintNumber: z.number().int().nonnegative(),
  currentGitRef: z.string().nullable(),
  lastSyncedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const workspaceFileManifestEntrySchema = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
});

export const sprintSnapshotSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  sprintNumber: z.number().int().positive(),
  gitTag: z.string(),
  bundleKey: z.string().nullable(),
  bundleSha256: z.string().nullable(),
  bundleBytes: z.number().int().nonnegative().nullable(),
  snapshotData: z.lazy(() => companySnapshotSchema),
  fileManifest: z.array(workspaceFileManifestEntrySchema),
  status: sprintSnapshotStatusSchema,
  createdAt: z.string(),
});

export const assetRecordSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  provider: z.string(),
  objectKey: z.string(),
  contentType: z.string(),
  byteSize: z.number().int().nonnegative(),
  sha256: z.string(),
  originalFilename: z.string().nullable(),
  namespace: z.string(),
  createdByAgent: z.string().nullable(),
  createdAt: z.string(),
});

export const exportResultSchema = z.object({
  assetId: z.string().nullable(),
  objectKey: z.string(),
  signedUrl: z.string(),
  expiresAt: z.string(),
  byteSize: z.number().int().nonnegative(),
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
  "escalation_received",
  "bug_reported",
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

// ── Spec 21: Sprint Verification & QA Framework ─────────────

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
  gateResults: z.array(verificationGateResultSchema),
  bugTaskIds: z.array(z.string()),
  reworkCycleCount: z.number().int().nonnegative(),
  maxReworkCycles: z.number().int().positive().default(3),
  testerVerdict: z.enum(["pending", "pass", "fail"]).nullable(),
  escalatedToCto: z.boolean(),
  ctoDecision: z.enum(["fix", "skip", "abort"]).nullable(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
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

// ── Spec 13: Policy Governance Gateway ──────────────────────

export const policyDecisionKindSchema = z.enum(["allow", "deny", "escalate"]);

export const policyRuleSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  /** Which roles this rule applies to; empty = all */
  appliesTo: z.array(roleTypeSchema).default([]),
  /** Tool name patterns this rule governs (glob-like, e.g. "file_*") */
  toolPatterns: z.array(z.string()).default([]),
  /** Minimum trust score required; below this the rule fires */
  minTrust: z.number().min(0).max(1).default(0),
  /** What happens when the rule fires */
  decision: policyDecisionKindSchema,
  /** If true, rule is currently active */
  enabled: z.boolean().default(true),
  priority: z.number().int().default(0),
  /** Optional regex pattern for file-path enforcement (e.g. "\\.(test|spec)\\.") */
  filePattern: z.string().optional(),
});

export const policyEvalContextSchema = z.object({
  agentId: z.string(),
  role: roleTypeSchema,
  tool: z.string(),
  trustScore: z.number().min(0).max(1),
  beatId: z.string().optional(),
  companyId: z.string(),
  /** File path being accessed — used for file-pattern rules (Spec 21) */
  filePath: z.string().optional(),
});

export const policyDecisionSchema = z.object({
  ruleId: z.string(),
  ruleName: z.string(),
  decision: policyDecisionKindSchema,
  reason: z.string(),
  evaluatedAt: z.string(),
});

export const trustScoreSchema = z.object({
  agentId: z.string(),
  score: z.number().min(0).max(1),
  history: z.array(z.object({
    delta: z.number(),
    reason: z.string(),
    timestamp: z.string(),
  })).default([]),
  updatedAt: z.string(),
});

export const trustEventKindSchema = z.enum([
  "task_completed",
  "task_failed",
  "violation",
  "escalation_resolved",
  "manual_adjustment",
]);

export const trustEventSchema = z.object({
  agentId: z.string(),
  kind: trustEventKindSchema,
  delta: z.number(),
  reason: z.string(),
  timestamp: z.string(),
});

export const policySeveritySchema = z.enum(["low", "medium", "high", "critical"]);

export const policyViolationSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  agentId: z.string(),
  ruleId: z.string(),
  tool: z.string(),
  decision: policyDecisionKindSchema,
  severity: policySeveritySchema,
  detail: z.string(),
  beatId: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  createdAt: z.string(),
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
export type WorkspaceInfo = z.infer<typeof workspaceInfoSchema>;
export type WorkspaceFileManifestEntry = z.infer<typeof workspaceFileManifestEntrySchema>;
export type SprintSnapshot = z.infer<typeof sprintSnapshotSchema>;
export type AssetRecord = z.infer<typeof assetRecordSchema>;
export type ExportResult = z.infer<typeof exportResultSchema>;
export type ExecutionStatus = z.infer<typeof executionStatusSchema>;
export type TransitionStatus = z.infer<typeof transitionStatusSchema>;
export type FeedbackVerdict = z.infer<typeof feedbackVerdictSchema>;
export type Transition = z.infer<typeof transitionSchema>;
export type TransitionProposal = z.infer<typeof transitionProposalSchema>;
export type RouterDecision = z.infer<typeof routerDecisionSchema>;
export type FeedbackRound = z.infer<typeof feedbackRoundSchema>;
export type CompanySnapshot = z.infer<typeof companySnapshotSchema>;

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

// Governance types (Spec 13)
export type PolicyDecisionKind = z.infer<typeof policyDecisionKindSchema>;
export type PolicyRule = z.infer<typeof policyRuleSchema>;
export type PolicyEvalContext = z.infer<typeof policyEvalContextSchema>;
export type PolicyDecision = z.infer<typeof policyDecisionSchema>;
export type TrustScore = z.infer<typeof trustScoreSchema>;
export type TrustEventKind = z.infer<typeof trustEventKindSchema>;
export type TrustEvent = z.infer<typeof trustEventSchema>;
export type PolicySeverity = z.infer<typeof policySeveritySchema>;
export type PolicyViolation = z.infer<typeof policyViolationSchema>;

// Skill Evolution types (Spec 14)

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

// Sprint Verification types (Spec 21)
export type VerificationGateResult = z.infer<typeof verificationGateResultSchema>;
export type SprintReviewPhase = z.infer<typeof sprintReviewPhaseSchema>;
export type SprintReviewState = z.infer<typeof sprintReviewStateSchema>;
export type DefectArea = z.infer<typeof defectAreaSchema>;
