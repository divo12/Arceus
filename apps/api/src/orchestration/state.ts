/**
 * Orchestrator shared state — mutable singletons, constants, and convenience getters.
 */

import type { AgentIdentity, BeatEventTrigger, CompanySnapshot, FeedbackRound, Task, Transition } from "@arceus/contracts";
import type { MeetingScheduler } from "@arceus/company-runtime";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { isInternalAgentRole } from "@arceus/company-runtime";
import { orchestratorConfig } from "../config/index.js";

// ─── Types ────────────────────────────────────────────────────────
export interface AgentSessionState {
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
}

export interface Artifact {
  id: string;
  agent: string;
  kind: "plan" | "code" | "output" | "specification" | "handoff";
  title: string;
  content: string;
  createdAt: string;
}

export type ExecutionStatus = "idle" | "planning" | "executing" | "verifying" | "awaiting_board_review" | "paused" | "done" | "error";

export interface ExecutionContext {
  companyId: string;
  buildTaskId: string;
  previewTaskId: string;
  reviewTaskId: string;
}

export interface MeetingAgendaInput {
  topic: string;
  type: "update" | "blocker" | "question" | "proposal";
  content: string;
  raisedByRole: AgentIdentity["role"];
  relatedTaskId?: string | null;
  needsBoardApproval?: boolean;
}

export interface MeetingDecisionInput {
  description: string;
  decidedByRoles: AgentIdentity["role"][];
  impactIds: string[];
}

export interface MeetingLearningInput {
  role: AgentIdentity["role"];
  content: string;
  promotedToSummary?: boolean;
}

export interface TaskModificationInput {
  taskId: string;
  modificationType: "assign" | "reprioritize" | "reassign" | "cancel" | "decompose_further" | "unblock";
  details: string;
  assignedRole?: AgentIdentity["role"] | null;
  priority?: Task["priority"] | null;
  resultingStatus?: Task["status"] | null;
}

export interface MemoryModificationInput {
  role: AgentIdentity["role"];
  modificationType: "current_focus" | "recent_learning" | "active_pattern" | "open_blocker" | "important_decision" | "clear_blocker";
  content: string;
}

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
/** Set the current execution status. */
export function setExecutionStatus(s: ExecutionStatus) { executionStatus = s; }
/** Set whether the event bridge has been started. */
export function setEventBridgeStarted(v: boolean) { eventBridgeStarted = v; }
/** Set the prompt completion poller interval handle. */
export function setPromptCompletionPollerHandle(h: NodeJS.Timeout | null) { promptCompletionPollerHandle = h; }
/** Set the active execution context (or null to clear). */
export function setActiveExecution(ctx: ExecutionContext | null) { activeExecution = ctx; }
/** Set the developer stall watchdog timer. */
export function setDeveloperWatchdog(t: NodeJS.Timeout | null) { developerWatchdog = t; }
/** Set the developer workspace monitor interval. */
export function setDeveloperWorkspaceMonitor(t: NodeJS.Timeout | null) { developerWorkspaceMonitor = t; }
/** Replace the developer workspace file-size snapshot. */
export function setDeveloperWorkspaceSnapshot(m: Map<string, number>) { developerWorkspaceSnapshot = m; }
/** Set whether the developer step loop is currently active. */
export function setDeveloperStepLoopActive(v: boolean) { developerStepLoopActive = v; }
/** Set whether a CEO proposal LLM call is in flight. */
export function setCeoProposalInFlight(v: boolean) { ceoProposalInFlight = v; }
/** Set the CEO proposal consecutive failure count. */
export function setCeoProposalFailureCount(n: number) { ceoProposalFailureCount = n; }
/** Set the CEO proposal cooldown expiry timestamp (epoch ms). */
export function setCeoProposalCooldownUntilMs(ms: number) { ceoProposalCooldownUntilMs = ms; }
/** Set whether sprint completion has already been triggered this cycle. */
export function setSprintCompletionTriggered(v: boolean) { sprintCompletionTriggered = v; }

// ─── Reactive event emitter (wired by server.ts) ─────────────────
let reactiveEventEmitter: ((companyId: string, agentId: string, role: AgentIdentity["role"], event: BeatEventTrigger) => void) | null = null;
/** Wire the reactive event emitter (called once from server.ts). */
export function setReactiveEventEmitter(fn: typeof reactiveEventEmitter) { reactiveEventEmitter = fn; }
/** Get the current reactive event emitter (may be null before wiring). */
export function getReactiveEventEmitter() { return reactiveEventEmitter; }

// ─── Meeting scheduler ref (wired by server.ts) ──────────────────
let meetingSchedulerRef: MeetingScheduler | null = null;
/** Wire the meeting scheduler instance (called once from server.ts). */
export function setMeetingScheduler(scheduler: MeetingScheduler) { meetingSchedulerRef = scheduler; }
/** Get the meeting scheduler (may be null before wiring). */
export function getMeetingSchedulerRef() { return meetingSchedulerRef; }

// ─── Convenience getters (for route handlers) ────────────────────
/** Get the raw agent sessions map (includes internal agents). */
export function getAgentSessionsMap() { return agentSessions; }
/** Get public-facing agent sessions, filtering out internal system agents. */
export function getAgentSessions() {
  // Filter out internal system agents from public-facing session state
  return Object.fromEntries(
    [...agentSessions].filter(([role]) => !isInternalAgentRole(role)),
  );
}
/** Get all stored artifacts. */
export function getArtifacts() { return artifacts; }
/** Get the current execution status string. */
export function getExecutionStatus() { return executionStatus; }
/** Get the active execution context (or null). */
export function getActiveExecution() { return activeExecution; }
/**
 * Spec 31 Phase 7.B.4 — transitions + feedback rounds moved off the
 * in-memory snapshot. They live in module-local arrays now; spec
 * 7.A.2 routes them through `activity_log` once that decision lands
 * (the canonical schema already exists). Until then this is the
 * single owner of both append + read.
 */
const transitionsLog: Transition[] = [];
const feedbackRoundsLog: FeedbackRound[] = [];

/** Append a state transition to the in-memory log. */
export function recordTransition(transition: Transition): void {
  transitionsLog.push(transition);
}

/** Append a feedback round to the in-memory log. */
export function recordFeedbackRound(round: FeedbackRound): void {
  feedbackRoundsLog.push(round);
}

/** Get task state transitions (read-only view of the log). */
export function getTransitions(): readonly Transition[] { return transitionsLog; }
/** Get feedback rounds (read-only view of the log). */
export function getFeedbackRounds(): readonly FeedbackRound[] { return feedbackRoundsLog; }

// ─── Reset (for tests / server restart) ──────────────────────────

/** Reset all orchestrator state to initial values. Used in tests and server restart. */
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

/** Count non-core tasks still in created/planned status. */
export function getQueuedNonCoreTaskCount(snapshot: CompanySnapshot) {
  return snapshot.tasks.filter(
    (task) => !CORE_EXECUTION_TASK_KINDS.has(task.kind) && ["created", "planned"].includes(task.status),
  ).length;
}

/** Determine whether execution should pause for board review (pending approvals or incomplete core tasks). */
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
