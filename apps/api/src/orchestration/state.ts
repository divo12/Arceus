/**
 * Orchestrator state facade — delegates to `CompanyRuntime`.
 *
 * Storage now lives in `./company-runtime.ts` (the `companyRuntime` singleton).
 * This file remains as a thin facade so the 25 existing import paths keep
 * working without churn during the migration. New code should import the
 * runtime directly.
 *
 * ESM `let` exports do NOT propagate live updates across module boundaries
 * when storage moves — so the previous `export let executionStatus` /
 * `activeExecution` / etc. are now exposed only through `getX()` accessors.
 * Callers that did bare reads have been migrated; callers that already
 * used `getExecutionStatus()` / `getActiveExecution()` are unchanged.
 */

import type { AgentIdentity, BeatEventTrigger, CompanySnapshot, Task } from "@arceus/contracts";
import type { MeetingScheduler } from "@arceus/company-runtime";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { isInternalAgentRole } from "@arceus/company-runtime";
import { orchestratorConfig } from "../config/index.js";
import { companyRuntime } from "./company-runtime.js";
import type { AgentSessionState, ExecutionStatus, ExecutionContext } from "./company-runtime.js";

export type { AgentSessionState, ExecutionStatus, ExecutionContext } from "./company-runtime.js";

// ─── Other types (unchanged from prior state.ts) ──────────────────
export interface Artifact {
  id: string;
  agent: string;
  kind: "plan" | "code" | "output" | "specification" | "handoff";
  title: string;
  content: string;
  createdAt: string;
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

// ─── Constants (unchanged) ────────────────────────────────────────
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

// ─── Workspace paths (unchanged — these are pure constants) ───────
export const workspaceRoot = resolve(process.cwd(), "..", "..");
export const productDir = existsSync(resolve(workspaceRoot, "workspace")) || !process.cwd().startsWith("/app")
  ? resolve(workspaceRoot, "workspace")
  : resolve(process.cwd(), "workspace");

// ─── Stable references (Maps + gates — safe to re-export by ref) ──
export const agentSessions = companyRuntime.agentSessions;
export const pendingPromptCompletions = companyRuntime.pendingPromptCompletions;
export const eventBridgeOnce = companyRuntime.eventBridgeOnce;
export const sprintCompletionGate = companyRuntime.sprintCompletionGate;

// ─── Mutable-cell accessors (replace prior `export let X`) ────────
/** Get the current execution status string. */
export function getExecutionStatus(): ExecutionStatus { return companyRuntime.executionStatus; }
/** Set the current execution status. */
export function setExecutionStatus(s: ExecutionStatus): void { companyRuntime.executionStatus = s; }

/** Get the active execution context (or null). */
export function getActiveExecution(): ExecutionContext | null { return companyRuntime.activeExecution; }
/** Set the active execution context (or null to clear). */
export function setActiveExecution(ctx: ExecutionContext | null): void { companyRuntime.activeExecution = ctx; }

/** Get the prompt completion poller interval handle. */
export function getPromptCompletionPollerHandle(): NodeJS.Timeout | null { return companyRuntime.promptCompletionPollerHandle; }
/** Set the prompt completion poller interval handle. */
export function setPromptCompletionPollerHandle(h: NodeJS.Timeout | null): void { companyRuntime.promptCompletionPollerHandle = h; }

/** Get the developer stall watchdog timer. */
export function getDeveloperWatchdog(): NodeJS.Timeout | null { return companyRuntime.developerWatchdog; }
/** Set the developer stall watchdog timer. */
export function setDeveloperWatchdog(t: NodeJS.Timeout | null): void { companyRuntime.developerWatchdog = t; }

/** Get the developer workspace monitor interval. */
export function getDeveloperWorkspaceMonitor(): NodeJS.Timeout | null { return companyRuntime.developerWorkspaceMonitor; }
/** Set the developer workspace monitor interval. */
export function setDeveloperWorkspaceMonitor(t: NodeJS.Timeout | null): void { companyRuntime.developerWorkspaceMonitor = t; }

/** Get the developer workspace file-size snapshot. */
export function getDeveloperWorkspaceSnapshot(): Map<string, number> { return companyRuntime.developerWorkspaceSnapshot; }
/** Replace the developer workspace file-size snapshot. */
export function setDeveloperWorkspaceSnapshot(m: Map<string, number>): void { companyRuntime.developerWorkspaceSnapshot = m; }

/** Get whether the developer step loop is currently active. */
export function getDeveloperStepLoopActive(): boolean { return companyRuntime.developerStepLoopActive; }
/** Set whether the developer step loop is currently active. */
export function setDeveloperStepLoopActive(v: boolean): void { companyRuntime.developerStepLoopActive = v; }

// ─── Reactive event emitter (wired by server.ts) ─────────────────
/** Wire the reactive event emitter (called once from server.ts). */
export function setReactiveEventEmitter(
  fn: ((companyId: string, agentId: string, role: AgentIdentity["role"], event: BeatEventTrigger) => void) | null,
): void { companyRuntime.reactiveEventEmitter = fn; }
/** Get the current reactive event emitter (may be null before wiring). */
export function getReactiveEventEmitter() { return companyRuntime.reactiveEventEmitter; }

// ─── Heartbeat engine ref (wired by server.ts) ──────────────────
let heartbeatEngineRef: { start(): void; stop(): void } | null = null;
/** Wire the heartbeat engine instance (called once from server.ts). */
export function setHeartbeatEngineRef(engine: { start(): void; stop(): void }) { heartbeatEngineRef = engine; }
/** Get the heartbeat engine (may be null before wiring). */
export function getHeartbeatEngineRef() { return heartbeatEngineRef; }

// ─── Meeting scheduler ref (wired by server.ts) ──────────────────
/** Wire the meeting scheduler instance (called once from server.ts). */
export function setMeetingScheduler(scheduler: MeetingScheduler): void { companyRuntime.meetingSchedulerRef = scheduler; }
/** Get the meeting scheduler (may be null before wiring). */
export function getMeetingSchedulerRef(): MeetingScheduler | null { return companyRuntime.meetingSchedulerRef; }

// ─── Meeting pipeline runner (wired by server.ts) ────────────────
// Spec 35 §5 — async chat-requested meetings need to run the pipeline
// fire-and-forget from a route handler. We expose just `run(id)` rather
// than the whole pipeline so callers can't subvert other deps.
let meetingPipelineRunner: ((meetingId: string) => Promise<void>) | null = null;
export function setMeetingPipelineRunner(fn: (meetingId: string) => Promise<void>) {
  meetingPipelineRunner = fn;
}
export function getMeetingPipelineRunner() { return meetingPipelineRunner; }

// ─── Convenience getters (for route handlers) ────────────────────
/** Get the raw agent sessions map (includes internal agents). */
export function getAgentSessionsMap(): Map<string, AgentSessionState> { return companyRuntime.agentSessions; }
/** Get public-facing agent sessions, filtering out internal system agents. */
export function getAgentSessions() {
  return Object.fromEntries(
    [...companyRuntime.agentSessions].filter(([role]) => !isInternalAgentRole(role)),
  );
}

// ─── Reset (for tests / server restart) ──────────────────────────
/** Reset all orchestrator state to initial values. Used in tests and server restart. */
export function resetOrchestratorState(): void { companyRuntime.reset(); }

// ─── Snapshot query helpers (unchanged — pure functions) ──────────
/** Count non-core tasks still in created/planned status. */
export function getQueuedNonCoreTaskCount(snapshot: CompanySnapshot): number {
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
