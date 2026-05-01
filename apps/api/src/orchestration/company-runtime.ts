/**
 * CompanyRuntime — single-tenant runtime state container.
 * Spec 34 v3 / Architecture deepening candidate #1.
 *
 * The 11 module-level `let`/`Map`/`Set` exports that previously lived in
 * `orchestration/state.ts` are now fields on a `CompanyRuntime` instance.
 * The interface is the class — callers go through the singleton, tests
 * can construct a fresh instance, and per-company instances become
 * possible later without rewriting consumers.
 *
 * Owns:
 *   - agentSessions               in-memory session-state map (PER ROLE,
 *                                  not per-company yet — single-tenant)
 *   - executionStatus              global execution-cycle status string
 *   - activeExecution              active build/preview/review task triple
 *   - pendingPromptCompletions     in-flight prompt resolvers
 *   - promptCompletionPollerHandle interval timer for prompt-completion poll
 *   - developerWatchdog            developer stall watchdog timer
 *   - developerWorkspaceMonitor    developer workspace-change monitor
 *   - developerWorkspaceSnapshot   file-size snapshot for change detection
 *   - developerStepLoopActive      developer step-loop guard flag
 *   - eventBridgeOnce              OncePromise for event-bridge startup
 *   - sprintCompletionGate         TryRunGate for re-entrant sprint completion
 *   - reactiveEventEmitter         server.ts wires this at boot
 *   - meetingSchedulerRef          server.ts wires this at boot
 *
 * Today there is exactly one instance (`companyRuntime`). Multi-tenant
 * support means: replace the singleton with a `Map<companyId, CompanyRuntime>`
 * and thread the lookup through `BeatDependencies` + route handlers. The
 * fields don't move; the instantiation site does.
 */
import type { AgentIdentity, BeatEventTrigger } from "@arceus/contracts";
import type { MeetingScheduler } from "@arceus/company-runtime";
import { OncePromise, TryRunGate } from "@arceus/runtime-shared";

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

export type ExecutionStatus =
  | "idle"
  | "planning"
  | "executing"
  | "verifying"
  | "awaiting_board_review"
  | "paused"
  | "done"
  | "error";

export interface ExecutionContext {
  companyId: string;
  buildTaskId: string;
  previewTaskId: string;
  reviewTaskId: string;
}

export interface PendingPromptCompletion {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

type ReactiveEmitter = (
  companyId: string,
  agentId: string,
  role: AgentIdentity["role"],
  event: BeatEventTrigger,
) => void;

export class CompanyRuntime {
  // ── Sessions ─────────────────────────────────────────────────
  readonly agentSessions = new Map<string, AgentSessionState>();

  // ── Execution status ─────────────────────────────────────────
  executionStatus: ExecutionStatus = "idle";
  activeExecution: ExecutionContext | null = null;

  // ── Prompt completion bookkeeping ────────────────────────────
  readonly pendingPromptCompletions = new Map<string, PendingPromptCompletion>();
  promptCompletionPollerHandle: NodeJS.Timeout | null = null;

  // ── Developer watchdog / monitor ─────────────────────────────
  developerWatchdog: NodeJS.Timeout | null = null;
  developerWorkspaceMonitor: NodeJS.Timeout | null = null;
  developerWorkspaceSnapshot = new Map<string, number>();
  developerStepLoopActive = false;

  // ── Concurrency gates (Audit C6 — F-273/274/290, F-315/319, F-043) ──
  readonly eventBridgeOnce = new OncePromise();
  readonly sprintCompletionGate = new TryRunGate();

  // ── External refs (wired by server.ts at boot) ────────────────
  reactiveEventEmitter: ReactiveEmitter | null = null;
  meetingSchedulerRef: MeetingScheduler | null = null;

  /** Reset all runtime state to initial values. Used in tests and server restart. */
  reset(): void {
    this.agentSessions.clear();
    this.executionStatus = "idle";
    this.pendingPromptCompletions.clear();
    if (this.promptCompletionPollerHandle) {
      clearInterval(this.promptCompletionPollerHandle);
      this.promptCompletionPollerHandle = null;
    }
    this.activeExecution = null;
    if (this.developerWatchdog) {
      clearTimeout(this.developerWatchdog);
      this.developerWatchdog = null;
    }
    if (this.developerWorkspaceMonitor) {
      clearInterval(this.developerWorkspaceMonitor);
      this.developerWorkspaceMonitor = null;
    }
    this.developerWorkspaceSnapshot = new Map();
    this.developerStepLoopActive = false;
    // Gates auto-clear on settle; nothing to reset. The `eventBridgeOnce`
    // and `sprintCompletionGate` instances stay in place across resets so
    // any in-flight work observes a consistent gate.
    this.reactiveEventEmitter = null;
    this.meetingSchedulerRef = null;
  }
}

/**
 * The singleton instance. Single-tenant today. To go multi-tenant, swap
 * for a `Map<companyId, CompanyRuntime>` lookup driven by route + beat
 * context. The class itself doesn't change — only the instantiation site.
 */
export const companyRuntime = new CompanyRuntime();
