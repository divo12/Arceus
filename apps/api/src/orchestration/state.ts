import type { AgentIdentity, BeatEventTrigger, CompanySnapshot, Task } from "@arceus/contracts";
import type { MeetingScheduler } from "@arceus/company-runtime";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { orchestratorConfig } from "../config/index.js";
import { getSnapshot } from "../persistence/store.js";

// ─── Types ────────────────────────────────────────────────────────
export type AgentSessionState = {
  role: string;
  agentId: string;
  sessionId: string;
  name: string;
  status: "idle" | "working" | "done" | "error";
  lastEventAt: string | null;
  lastEventType: string | null;
  lastEventSummary: string | null;
  lastToolName: string | null;
  lastToolStatus: "invoked" | "completed" | null;
  lastToolAt: string | null;
  lastProgressAt: string | null;
  lastWorkspaceChangeAt: string | null;
  awaiting: string | null;
  activeTaskId: string | null;
  promptStartedAt: string | null;
  promptCompletedAt: string | null;
  eventCount: number;
  toolInvocationCount: number;
  fileEditCount: number;
  shellCommandCount: number;
  stallReason: string | null;
};

export type Artifact = {
  id: string;
  agent: string;
  kind: "plan" | "code" | "output" | "specification";
  title: string;
  content: string;
  createdAt: string;
};

export type ExecutionStatus = "idle" | "planning" | "executing" | "verifying" | "awaiting_board_review" | "paused" | "done" | "error";

export type ExecutionContext = {
  companyId: string;
  buildTaskId: string;
  previewTaskId: string;
  reviewTaskId: string;
};

export type MeetingAgendaInput = {
  topic: string;
  type: "update" | "blocker" | "question" | "proposal";
  content: string;
  raisedByRole: AgentIdentity["role"];
  relatedTaskId?: string | null;
  needsBoardApproval?: boolean;
};

export type MeetingDecisionInput = {
  description: string;
  decidedByRoles: AgentIdentity["role"][];
  impactIds: string[];
};

export type MeetingLearningInput = {
  role: AgentIdentity["role"];
  content: string;
  promotedToSummary?: boolean;
};

export type TaskModificationInput = {
  taskId: string;
  modificationType: "assign" | "reprioritize" | "reassign" | "cancel" | "decompose_further" | "unblock";
  details: string;
  assignedRole?: AgentIdentity["role"] | null;
  priority?: Task["priority"] | null;
  resultingStatus?: Task["status"] | null;
};

export type MemoryModificationInput = {
  role: AgentIdentity["role"];
  modificationType: "current_focus" | "recent_learning" | "active_pattern" | "open_blocker" | "important_decision" | "clear_blocker";
  content: string;
};

// ─── Constants ────────────────────────────────────────────────────
export const CORE_EXECUTION_TASK_KINDS = new Set<Task["kind"]>(orchestratorConfig.coreExecutionTaskKinds);
export const AUTONOMOUS_READY_TASK_ROLES = new Set<AgentIdentity["role"]>(orchestratorConfig.autonomousReadyTaskRoles);
export const PROMPT_COMPLETION_POLL_INTERVAL_MS = 8_000;
export const DEVELOPER_STALL_TIMEOUT_MINUTES = orchestratorConfig.developer.stallTimeoutMinutes;
export const DEVELOPER_STALL_TIMEOUT_MS = DEVELOPER_STALL_TIMEOUT_MINUTES * 60 * 1000;
export const WORKSPACE_MONITOR_INTERVAL_MS = orchestratorConfig.developer.workspaceMonitorIntervalMs;
export const WORKSPACE_MONITOR_IGNORE = new Set(orchestratorConfig.developer.workspaceMonitorIgnore);
export const MAX_FINDINGS_PER_TASK = 6;
export const CEO_PROPOSAL_FAILURES_BEFORE_COOLDOWN = 3;
export const CEO_PROPOSAL_COOLDOWN_MS = 2 * 60 * 1000;

// ─── Workspace paths ──────────────────────────────────────────────
export const workspaceRoot = resolve(process.cwd(), "..", "..");
export const productDir = existsSync(resolve(workspaceRoot, "workspace")) || !process.cwd().startsWith("/app")
  ? resolve(workspaceRoot, "workspace")
  : resolve(process.cwd(), "workspace");

// ─── Mutable state ────────────────────────────────────────────────
export const agentSessions = new Map<string, AgentSessionState>();
export const artifacts: Artifact[] = [];
export let executionStatus: ExecutionStatus = "idle";
export let eventBridgeStarted = false;
export const pendingPromptCompletions = new Map<string, { resolve: () => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>();
export let promptCompletionPollerHandle: NodeJS.Timeout | null = null;
export let activeExecution: ExecutionContext | null = null;
export let developerWatchdog: NodeJS.Timeout | null = null;
export let developerWorkspaceMonitor: NodeJS.Timeout | null = null;
export let developerWorkspaceSnapshot = new Map<string, number>();
export let developerStepLoopActive = false;
export let ceoProposalInFlight = false;
export let ceoProposalFailureCount = 0;
export let ceoProposalCooldownUntilMs = 0;
export let sprintCompletionTriggered = false;

// ─── State setters (for `let` exports that can't be reassigned from outside) ──
export function setExecutionStatus(s: ExecutionStatus) { executionStatus = s; }
export function setEventBridgeStarted(v: boolean) { eventBridgeStarted = v; }
export function setPromptCompletionPollerHandle(h: NodeJS.Timeout | null) { promptCompletionPollerHandle = h; }
export function setActiveExecution(ctx: ExecutionContext | null) { activeExecution = ctx; }
export function setDeveloperWatchdog(t: NodeJS.Timeout | null) { developerWatchdog = t; }
export function setDeveloperWorkspaceMonitor(t: NodeJS.Timeout | null) { developerWorkspaceMonitor = t; }
export function setDeveloperWorkspaceSnapshot(m: Map<string, number>) { developerWorkspaceSnapshot = m; }
export function setDeveloperStepLoopActive(v: boolean) { developerStepLoopActive = v; }
export function setCeoProposalInFlight(v: boolean) { ceoProposalInFlight = v; }
export function setCeoProposalFailureCount(n: number) { ceoProposalFailureCount = n; }
export function setCeoProposalCooldownUntilMs(ms: number) { ceoProposalCooldownUntilMs = ms; }
export function setSprintCompletionTriggered(v: boolean) { sprintCompletionTriggered = v; }

// ─── Reactive event emitter (wired by server.ts) ─────────────────
let reactiveEventEmitter: ((companyId: string, agentId: string, role: AgentIdentity["role"], event: BeatEventTrigger) => void) | null = null;
export function setReactiveEventEmitter(fn: typeof reactiveEventEmitter) { reactiveEventEmitter = fn; }
export function getReactiveEventEmitter() { return reactiveEventEmitter; }

// ─── Meeting scheduler ref (wired by server.ts) ──────────────────
let meetingSchedulerRef: MeetingScheduler | null = null;
export function setMeetingScheduler(scheduler: MeetingScheduler) { meetingSchedulerRef = scheduler; }
export function getMeetingSchedulerRef() { return meetingSchedulerRef; }

// ─── Convenience getters (for route handlers) ────────────────────
export function getAgentSessionsMap() { return agentSessions; }
export function getAgentSessions() { return Object.fromEntries(agentSessions); }
export function getArtifacts() { return artifacts; }
export function getExecutionStatus() { return executionStatus; }
export function getActiveExecution() { return activeExecution; }
export function getTransitions() { return getSnapshot().transitions ?? []; }
export function getFeedbackRounds() { return getSnapshot().feedbackRounds ?? []; }

// ─── Reset (for tests / server restart) ──────────────────────────
export function resetOrchestratorState() {
  agentSessions.clear();
  artifacts.length = 0;
  executionStatus = "idle";
  eventBridgeStarted = false;
  pendingPromptCompletions.clear();
  if (promptCompletionPollerHandle) { clearInterval(promptCompletionPollerHandle); promptCompletionPollerHandle = null; }
  activeExecution = null;
  if (developerWatchdog) { clearTimeout(developerWatchdog); developerWatchdog = null; }
  if (developerWorkspaceMonitor) { clearInterval(developerWorkspaceMonitor); developerWorkspaceMonitor = null; }
  developerWorkspaceSnapshot = new Map();
  developerStepLoopActive = false;
  ceoProposalInFlight = false;
  ceoProposalFailureCount = 0;
  ceoProposalCooldownUntilMs = 0;
  sprintCompletionTriggered = false;
  reactiveEventEmitter = null;
  meetingSchedulerRef = null;
}

// ─── Snapshot query helpers ───────────────────────────────────────
export function getQueuedNonCoreTaskCount(snapshot: CompanySnapshot) {
  return snapshot.tasks.filter(
    (task) => !CORE_EXECUTION_TASK_KINDS.has(task.kind) && ["created", "planned"].includes(task.status),
  ).length;
}

export function shouldPauseForBoardReview(snapshot: CompanySnapshot) {
  const pendingApprovals = snapshot.approvals.filter((approval) => approval.status === "pending");
  if (pendingApprovals.length > 0) {
    return {
      shouldPause: true,
      reason: `Board action required because ${pendingApprovals.length} approval request${pendingApprovals.length === 1 ? " is" : "s are"} still pending.`,
    };
  }

  const incompleteCoreTasks = snapshot.tasks.filter(
    (task) => CORE_EXECUTION_TASK_KINDS.has(task.kind) && !["completed", "cancelled"].includes(task.status),
  );
  if (incompleteCoreTasks.length > 0) {
    return {
      shouldPause: true,
      reason: "Board review required because core execution is not in a terminal state.",
    };
  }

  return { shouldPause: false, reason: null } as const;
}
