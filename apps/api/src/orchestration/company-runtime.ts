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
  /**
   * Epoch ms when this completion was registered. Stable — never updated.
   * Used by the no-tool-invoked early-exit guard to measure how long the
   * agent has been "thinking but not acting." Distinct from lastActivityAt
   * (which resets on any signal — SSE event or MCP request).
   */
  startedAt: number;
  /** Epoch ms of the last SSE event seen for this session. Used by the poller to detect stuck agents. */
  lastActivityAt: number;
  /**
   * Number of MCP tool invocations seen for this session since registration.
   * Incremented by `mcpRequestContext` middleware on every tool call. Read
   * by `pollPendingPromptCompletions` to early-exit beats that the LLM has
   * been "thinking about" for too long without taking any action.
   */
  toolCallCount: number;
  /**
   * Epoch ms when the agent last invoked a *productive* action tool
   * (task_claim, task_complete, artifact_create, workspace_checkpoint,
   * etc. — same set that resets the read-loop counter). Distinct from
   * `lastActivityAt`, which is bumped by ANY SSE event including
   * reasoning/text tokens and read-only tool calls.
   *
   * Used by the productive-action deadline guard to kill beats that
   * have spent N minutes in meta loops (task_get + task_append_plan_step
   * → silence → repeat) without ever making a state-changing move.
   * Defaults to `startedAt` so the first window starts at registration.
   */
  lastProductiveActionAt: number;
  /**
   * Epoch ms when the agent last completed ANY tool call (arceus_* via MCP
   * middleware, or built-in read/edit/bash/… via the plugin's watchdog-reset
   * POST). Defaults to `startedAt`.
   *
   * Distinct from `lastActivityAt`: that one is bumped by every SSE event
   * INCLUDING reasoning-token deltas, so a model that streams reasoning
   * forever without acting never trips the stall guard (observed on
   * gpt-5.2: ~10 min of reasoning after a tool result, killed only by the
   * hard cap with all work discarded). `lastToolAt` only moves on actual
   * tool calls, which is the signal the reasoning-stall guard needs.
   */
  lastToolAt: number;
  /**
   * Number of consecutive `read` calls (built-in OpenCode read tool) since
   * the last "action" tool fired. Bumped by the watchdog-reset endpoint
   * when the plugin posts a tool body with `tool === "read"`. Reset to 0
   * by the MCP middleware on `task_claim` or `artifact_create` (and any
   * other tool that meaningfully transitions state).
   *
   * The poller rejects with cause `read_loop` once this exceeds the
   * READ_LOOP_THRESHOLD — protects against the gpt-5.4-mini pathology
   * where the model re-reads the same SKILL.md file line-by-line via
   * `read({limit: 1, offset: N})` for hundreds of round-trips with zero
   * progress (observed in beat_4_1778410838848).
   */
  readsSinceAction: number;
  /**
   * Number of stall-nudge recoveries attempted for this beat. When the
   * SSE-silence guard trips, the poller first aborts the hung request
   * and re-prompts the same session (context intact) instead of reaping
   * the beat; only when nudges are exhausted does the stall reject.
   * Evidence for the hang class: beat 4 of 2026-06-11 (post-wipe) sat
   * at zero events for 5min+ while a direct Azure probe streamed fine —
   * the request hangs, not the model.
   */
  nudgeCount: number;
  /**
   * The hard-cap (ms) this completion was registered with — beats pass
   * HARD_CAP_MS, chat prompts the 5-min default. Lets the poller compute
   * the T-minus wrap-up moment without knowing who registered.
   */
  capMs: number;
  /** True once the T-minus wrap-up message has been sent (once per beat). */
  wrapUpSent: boolean;
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
