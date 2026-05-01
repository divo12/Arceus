/**
 * HeartbeatEngine — Spec 12 Phase 2
 *
 * Manages heartbeat scheduling for all agents. Each agent wakes
 * at its configured interval, self-assesses via a checklist, does
 * bounded work, and goes dormant.
 *
 * Beat lifecycle (4 phases):
 *   Phase 1 — Wake:      generate beatId, acquire lock, load AgentBeatContext
 *   Phase 2 — Observe:   run role checklist → all OK = HEARTBEAT_OK (skip)
 *   Phase 3 — Execute:   pick highest-priority task, delegate work, track tokens
 *   Phase 4 — Serialize: flush store, commit BeatRecord, update lastHeartbeatAt
 */

import type {
  AgentIdentity,
  AgentBeatContext,
  BeatRecord,
  BeatOutcome,
  BeatPhases,
  BeatStatus,
  BeatTrigger,
  BeatEventTrigger,
} from "@arceus/contracts";
import { runChecklist, type ChecklistResult } from "./heartbeat-checklist";
import { swallowAndAudit } from "./swallow.js";

// ── Types ──────────────────────────────────────────────────

export interface HeartbeatConfig {
  executionMode: "orchestrator" | "heartbeat";
  schedulerIntervalMs: number;
  maxConcurrentBeats: number;
  roleIntervals: Record<AgentIdentity["role"], number>;
  beatTimeoutMs: number;
  beatTokenBudget: number;
  beatCostCeilingCents: number;
  idleThresholdTokens: number;
  pauseWhenNoActiveSprint: boolean;
  pauseWhenBudgetExhausted: boolean;
  pauseRoles: AgentIdentity["role"][];
}

export interface BeatRequest {
  companyId: string;
  agentId: string;
  role: AgentIdentity["role"];
  trigger: BeatTrigger;
}

/** Callback invoked to execute the actual beat phases (Phase 2). */
export type BeatExecutor = (request: BeatRequest, beatId: string) => Promise<BeatRecord>;

/**
 * Dependencies injected from the API layer.
 * HeartbeatEngine lives in company-runtime (no direct API imports),
 * so the API layer supplies these callbacks at construction time.
 */
export interface BeatDependencies {
  /** Spec 31 Phase 7.C.d-cp — async to read from canonical via buildSnapshotView. */
  loadAgentContext: (
    agentId: string, beatId: string, beatNumber: number, trigger: BeatTrigger,
    config: { beatTokenBudget: number; beatCostCeilingCents: number }
  ) => Promise<AgentBeatContext | null>;

  getSnapshotVersion: () => number;

  /** Spec 31 Phase 7.C.d-cp — async to write through canonical mutators. */
  applyMutations: (
    companyId: string,
    mutations: { type: string; [key: string]: unknown }[],
    causation?: { eventId?: string; summary?: string },
    expectedVersion?: number
  ) => Promise<{ version: number; applied: number; errors: string[] }>;

  commitBeatRecord: (record: BeatRecord) => Promise<boolean>;
  flushStore: () => Promise<void>;

  audit: {
    auditAgent: (companyId: string, agentRole: string, eventType: string, summary: string, opts?: Record<string, unknown>) => void;
    auditSystem: (companyId: string, eventType: string, summary: string, opts?: Record<string, unknown>) => void;
    auditError: (companyId: string, eventType: string, summary: string, error?: unknown, opts?: Record<string, unknown>) => void;
  };

  /**
   * Wake the agent for this beat. The agent reads the rendered state, claims a
   * task via `task_claim` (if any are open), and acts via tools. The orchestrator
   * does NOT pre-select a task — see plans/agent-redesign/00-vision.md.
   */
  executeTask?: (ctx: AgentBeatContext, beatId: string) => Promise<{
    summary: string; tokensUsed: number; actionsCount: number; toolCalls: number; completed: boolean;
  }>;

  /** Execute a checklist-driven action when no task is available (e.g. CEO proposes sprint). */
  executeChecklistAction?: (ctx: AgentBeatContext, action: { detail: string; suggestedAction: string }, beatId: string) => Promise<{
    summary: string; tokensUsed: number; actionsCount: number; toolCalls: number;
  }>;

  /** Return list of agents for the scheduler to iterate. */
  /** Spec 31 Phase 7.C.c — async to read from canonical via repos. */
  getAgentRoster?: () => Promise<{ agentId: string; role: AgentIdentity["role"]; companyId: string }[]>;

  /** Emit beat lifecycle events for SSE streaming. */
  emitBeatEvent?: (event: { type: string; beatId: string; agentId: string; role: string; data?: Record<string, unknown> }) => void;
}

// ── Beat lock manager ──────────────────────────────────────

/** Prevents overlapping beats for the same agent. */
class BeatLockManager {
  private readonly locks = new Map<string, { beatId: string; acquiredAt: number }>();

  acquire(agentId: string, beatId: string): boolean {
    if (this.locks.has(agentId)) return false;
    this.locks.set(agentId, { beatId, acquiredAt: Date.now() });
    return true;
  }

  release(agentId: string): void {
    this.locks.delete(agentId);
  }

  isLocked(agentId: string): boolean {
    return this.locks.has(agentId);
  }

  /** Expire locks that exceed the timeout (safety net). */
  expireStale(timeoutMs: number): string[] {
    const now = Date.now();
    const expired: string[] = [];
    for (const [agentId, lock] of this.locks) {
      if (now - lock.acquiredAt > timeoutMs) {
        expired.push(agentId);
        this.locks.delete(agentId);
      }
    }
    return expired;
  }

  get activeCount(): number {
    return this.locks.size;
  }
}

// ── Concurrency semaphore ──────────────────────────────────

class Semaphore {
  private current = 0;
  constructor(private readonly max: number) {}

  tryAcquire(): boolean {
    if (this.current >= this.max) return false;
    this.current++;
    return true;
  }

  release(): void {
    this.current = Math.max(0, this.current - 1);
  }

  get available(): number {
    return this.max - this.current;
  }
}

// ── HeartbeatEngine ────────────────────────────────────────

export class HeartbeatEngine {
  private readonly config: HeartbeatConfig;
  private readonly deps: BeatDependencies | null;
  private readonly locks = new BeatLockManager();
  private readonly semaphore: Semaphore;
  private readonly lastBeatAt = new Map<string, number>(); // agentId → epoch ms
  private beatCounter = 0;
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  // ── Reactive event queue (Spec 12 Phase 3) ───────────────
  // Events queued while an agent is locked (mid-beat). Drained after beat completion.
  private readonly eventQueue = new Map<string, { companyId: string; role: AgentIdentity["role"]; event: BeatEventTrigger }[]>();

  // ── Staged mutations (P4.3) ──────────────────────────────
  // Beats stage mutations during Phase 3 (Execute) and flush
  // them atomically in Phase 4 (Serialize).
  private stagedMutations: { type: string; [key: string]: unknown }[] = [];

  /** Stage a mutation to be flushed at the end of the current beat. */
  stageMutation(mutation: { type: string; [key: string]: unknown }) {
    this.stagedMutations.push(mutation);
  }

  /** Flush all staged mutations via applyMutations, then clear. */
  private async flushStagedMutations(
    companyId: string,
    causation: { eventId?: string; summary?: string },
    expectedVersion?: number,
  ): Promise<{ version: number; applied: number; errors: string[] }> {
    if (this.stagedMutations.length === 0 || !this.deps) {
      return { version: expectedVersion ?? 0, applied: 0, errors: [] };
    }
    const result = await this.deps.applyMutations(companyId, this.stagedMutations, causation, expectedVersion);
    this.stagedMutations = [];
    return result;
  }

  private clearStagedMutations() {
    this.stagedMutations = [];
  }

  getStagedMutationCount(): number {
    return this.stagedMutations.length;
  }

  /** Legacy BeatExecutor for backward compat. Overridden when deps are supplied. */
  private executor: BeatExecutor;

  /**
   * HeartbeatEngine manages beat scheduling and execution for all agents.
   *
   * Beats follow a 4-phase lifecycle: Wake → Observe → Execute → Serialize.
   * Concurrency is bounded by a semaphore and per-agent locks prevent overlapping beats.
   * Reactive events (e.g., task assignment) can trigger immediate beats or queue
   * while an agent is mid-beat.
   */
  constructor(config: HeartbeatConfig, deps?: BeatDependencies, legacyExecutor?: BeatExecutor) {
    this.config = config;
    this.deps = deps ?? null;
    this.semaphore = new Semaphore(config.maxConcurrentBeats);
    this.executor = deps
      ? (req, beatId) => this.fourPhaseExecutor(req, beatId)
      : legacyExecutor ?? this.stubExecutor.bind(this);
  }

  // ── Lifecycle ────────────────────────────────────────────

  start(): void {
    if (this.running) return;
    if (this.config.executionMode !== "heartbeat") {
      console.log("[HEARTBEAT] Engine not started — execution mode is", this.config.executionMode);
      return;
    }
    this.running = true;
    this.schedulerTimer = setInterval(() => void this.tick(), this.config.schedulerIntervalMs);
    console.log(
      `[HEARTBEAT] Engine started (interval=${this.config.schedulerIntervalMs}ms, maxConcurrent=${this.config.maxConcurrentBeats})`
    );
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
    console.log("[HEARTBEAT] Engine stopped");
  }

  isBeating(): boolean {
    return this.running;
  }

  /** Set or replace the beat executor (Phase 2 wires in the real one). */
  setExecutor(executor: BeatExecutor): void {
    this.executor = executor;
  }

  // ── Manual trigger ───────────────────────────────────────

  /**
   * Trigger a beat for a specific agent. Returns the BeatRecord on success,
   * or null if the beat was skipped (locked, at capacity, paused, etc.).
   */
  async triggerBeat(request: BeatRequest): Promise<BeatRecord | null> {
    // Pause check
    if (this.config.pauseRoles.includes(request.role)) {
      return null;
    }

    // Concurrency
    if (!this.semaphore.tryAcquire()) {
      return null;
    }

    const beatId = `beat_${++this.beatCounter}_${Date.now()}`;

    // Agent lock
    if (!this.locks.acquire(request.agentId, beatId)) {
      this.semaphore.release();
      return null;
    }

    try {
      const record = await this.executor(request, beatId);
      this.lastBeatAt.set(request.agentId, Date.now());
      this.recordHistory(record);
      // Persist to DB (fire-and-forget — don't block the caller).
      // C3 sweep: surface the failure rather than swallow it. The beat is
      // still in `lastBeatAt` and recordHistory regardless, so a missed DB
      // write doesn't break the runtime — but it should be visible in logs
      // so we notice if the beats DB is failing systematically.
      if (this.deps) {
        // Audit C2.3 (F-112/F-217): commitBeatRecord failure means the
        // beat audit trail is dropping rows. Surface to the typed error
        // sink so monitoring catches systematic DB failures.
        swallowAndAudit("heartbeat.commit_beat_record", () =>
          this.deps!.commitBeatRecord(record),
          { companyId: record.companyId, beatId: record.id, detail: { agentId: record.agentId } },
        );
      }
      return record;
    } finally {
      this.locks.release(request.agentId);
      this.semaphore.release();
      // Drain any events that were queued while this agent was mid-beat
      this.drainEventQueue(request.agentId);
    }
  }

  // ── Reactive event dispatch ───────────────────────────────

  /**
   * Emit a reactive event for a specific agent. If the agent is idle (not
   * mid-beat), an immediate event-triggered beat fires. If the agent is
   * locked, the event is queued and drained after the current beat completes.
   */
  emitEvent(companyId: string, agentId: string, role: AgentIdentity["role"], event: BeatEventTrigger): void {
    if (this.locks.isLocked(agentId)) {
      // Agent is mid-beat — queue and drain after lock release
      const queue = this.eventQueue.get(agentId) ?? [];
      queue.push({ companyId, role, event });
      this.eventQueue.set(agentId, queue);
      return;
    }

    // Agent is idle — trigger immediately (fire-and-forget). Audit-routed
    // so a reactive beat that crashes lands in the error sink.
    swallowAndAudit("heartbeat.reactive_beat", () =>
      this.triggerBeat({
        companyId, agentId, role,
        trigger: { type: "event", event },
      }),
      { companyId, detail: { agentId, role, event } },
    );
  }

  /** Drain queued events for an agent after its beat completes. */
  private drainEventQueue(agentId: string): void {
    const queue = this.eventQueue.get(agentId);
    if (!queue || queue.length === 0) return;
    this.eventQueue.delete(agentId);

    // Fire a beat for the first queued event (subsequent events re-queue if needed)
    const next = queue.shift()!;
    // Re-queue remaining so they aren't lost
    if (queue.length > 0) {
      this.eventQueue.set(agentId, queue);
    }

    swallowAndAudit("heartbeat.queued_reactive_beat", () =>
      this.triggerBeat({
        companyId: next.companyId,
        agentId,
        role: next.role,
        trigger: { type: "event", event: next.event },
      }),
      { companyId: next.companyId, detail: { agentId, role: next.role, event: next.event } },
    );
  }

  // ── Status ───────────────────────────────────────────────

  /** In-memory beat history (capped). */
  private readonly beatHistory: BeatRecord[] = [];
  private static readonly MAX_HISTORY = 200;

  private recordHistory(record: BeatRecord) {
    this.beatHistory.push(record);
    if (this.beatHistory.length > HeartbeatEngine.MAX_HISTORY) {
      this.beatHistory.splice(0, this.beatHistory.length - HeartbeatEngine.MAX_HISTORY);
    }
  }

  getHistory(companyId?: string): BeatRecord[] {
    return companyId
      ? this.beatHistory.filter((r) => r.companyId === companyId)
      : [...this.beatHistory];
  }

  /** Update config at runtime (e.g. PATCH config endpoint). */
  patchConfig(patch: Partial<HeartbeatConfig>) {
    Object.assign(this.config, patch);
  }

  getConfig(): Readonly<HeartbeatConfig> {
    return { ...this.config };
  }

  getStatus() {
    return {
      running: this.running,
      activeLocks: this.locks.activeCount,
      semaphoreAvailable: this.semaphore.available,
      totalBeats: this.beatCounter,
      lastBeatAt: Object.fromEntries(this.lastBeatAt),
    };
  }

  /**
   * Clear per-company state when the company is reset.
   * Keeps the scheduler running and retains config/locks so the next company
   * inherits a warm scheduler without a restart. Safe to call repeatedly.
   */
  reset() {
    this.beatCounter = 0;
    this.beatHistory.length = 0;
    this.lastBeatAt.clear();
    this.stagedMutations = [];
    this.eventQueue.clear();
  }

  // ── Scheduler tick ───────────────────────────────────────

  /** Role priority weights: lower = higher priority. */
  private static readonly ROLE_PRIORITY: Record<AgentIdentity["role"], number> = {
    ceo: 0, cto: 1, pm: 2, developer: 3, tester: 4, ui_designer: 5, marketing: 6, skills_lead: 7,
  };

  /**
   * Called every schedulerIntervalMs. Expires stale locks, then auto-dispatches
   * beats for agents whose role interval has elapsed, in priority order.
   */
  private async tick(): Promise<void> {
    const expired = this.locks.expireStale(this.config.beatTimeoutMs);
    if (expired.length > 0) {
      console.warn("[HEARTBEAT] Expired stale locks for agents:", expired.join(", "));
    }

    // Need agent roster to auto-schedule
    if (!this.deps?.getAgentRoster) return;

    const roster = await this.deps.getAgentRoster();
    if (roster.length === 0) return;

    const now = Date.now();

    // Sort by overdue-ness (most overdue first), then by static priority as
    // tiebreaker. Static priority alone starves lower-priority roles like
    // ui_designer when maxConcurrentBeats=1 and higher-priority roles keep
    // becoming due — they win every tick. Sorting by (now - lastBeat -
    // interval) descending guarantees fairness while still preferring CEO
    // when all overdue ratios are equal.
    const sorted = [...roster].sort((a, b) => {
      const intA = this.config.roleIntervals[a.role] ?? this.config.schedulerIntervalMs * 10;
      const intB = this.config.roleIntervals[b.role] ?? this.config.schedulerIntervalMs * 10;
      const overdueA = now - (this.lastBeatAt.get(a.agentId) ?? 0) - intA;
      const overdueB = now - (this.lastBeatAt.get(b.agentId) ?? 0) - intB;
      if (overdueA !== overdueB) return overdueB - overdueA;
      return (HeartbeatEngine.ROLE_PRIORITY[a.role] ?? 99) - (HeartbeatEngine.ROLE_PRIORITY[b.role] ?? 99);
    });
    for (const agent of sorted) {
      // Skip paused roles
      if (this.config.pauseRoles.includes(agent.role)) continue;

      // Check per-role interval
      const interval = this.config.roleIntervals[agent.role] ?? this.config.schedulerIntervalMs * 10;
      const lastBeat = this.lastBeatAt.get(agent.agentId) ?? 0;
      if (now - lastBeat < interval) continue;

      // Skip if already locked
      if (this.locks.isLocked(agent.agentId)) continue;

      // Skip if at capacity
      if (this.semaphore.available <= 0) break;

      // Fire and forget — triggerBeat handles lock + semaphore.
      // Audit-routed so a scheduled beat crash lands in the error sink.
      swallowAndAudit("heartbeat.auto_schedule_beat", () =>
        this.triggerBeat({
          companyId: agent.companyId,
          agentId: agent.agentId,
          role: agent.role,
          trigger: { type: "interval", scheduledAt: new Date(now).toISOString() },
        }),
        { companyId: agent.companyId, detail: { agentId: agent.agentId, role: agent.role } },
      );
    }
  }

  // ── 4-Phase Beat Executor ────────────────────────────────

  private async fourPhaseExecutor(request: BeatRequest, beatId: string): Promise<BeatRecord> {
    const deps = this.deps!;
    const startedAt = new Date().toISOString();
    const phases: BeatPhases = {};
    let totalTokens = 0;
    let snapshotVersionWritten: number | null = null;

    // Clear any leftover staged mutations from prior beat
    this.clearStagedMutations();

    const timeout = { tripped: false };
    const timeoutHandle = setTimeout(() => { timeout.tripped = true; }, this.config.beatTimeoutMs);

    try {
      // ── Phase 1: Wake ──────────────────────────────────
      const wake = await this.executeWakePhase(request, beatId, phases);
      const snapshotVersionRead = wake.snapshotVersionRead;
      if (wake.kind === "skip") {
        return this.buildRecord(beatId, request, startedAt, phases, wake.status, wake.outcome, 0, null, wake.summary, snapshotVersionRead, null);
      }
      const { ctx } = wake;

      // ── Phase 2: Observe ─────────────────────────────────
      if (timeout.tripped) {
        return this.buildRecord(beatId, request, startedAt, phases, "timed_out", "TIMED_OUT", 0, "Beat timed out in observe phase", null, snapshotVersionRead, null);
      }
      const observe = this.executeObservePhase(ctx, request, beatId, phases);
      if (observe.kind === "exit") {
        return this.buildRecord(beatId, request, startedAt, phases, observe.status, observe.outcome, 0, null, observe.summary, snapshotVersionRead, null);
      }
      const { checklist } = observe;

      // ── Phase 3: Execute ─────────────────────────────────
      if (timeout.tripped) {
        return this.buildRecord(beatId, request, startedAt, phases, "timed_out", "TIMED_OUT", 0, "Beat timed out before execute phase", null, snapshotVersionRead, null);
      }
      const exec = await this.executeActPhase(ctx, request, beatId, phases, checklist);
      totalTokens += exec.tokens;

      // ── Phase 4: Serialize ───────────────────────────────
      if (timeout.tripped) {
        return this.buildRecord(beatId, request, startedAt, phases, "timed_out", "TIMED_OUT", totalTokens, "Beat timed out before serialize phase", null, snapshotVersionRead, null);
      }
      const serialize = await this.executeSerializePhase(request, beatId, phases, snapshotVersionRead);
      snapshotVersionWritten = serialize.snapshotVersionWritten;

      deps.audit.auditAgent(
        request.companyId, request.role,
        "beat_completed",
        `Beat ${beatId} completed: ${exec.outcome} — ${exec.summary}`,
        { beatId, detail: { outcome: exec.outcome, totalTokens, phases } }
      );
      deps.emitBeatEvent?.({ type: "beat_completed", beatId, agentId: request.agentId, role: request.role, data: { outcome: exec.outcome, totalTokens, summary: exec.summary } });

      return this.buildRecord(beatId, request, startedAt, phases, "completed", exec.outcome, totalTokens, null, exec.summary, snapshotVersionRead, snapshotVersionWritten);

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const summary = `Beat failed: ${errorMessage}`;
      this.clearStagedMutations();
      deps.audit.auditError(request.companyId, "beat_failed", summary, err, { beatId });
      deps.emitBeatEvent?.({ type: "beat_failed", beatId, agentId: request.agentId, role: request.role, data: { error: errorMessage } });
      return this.buildRecord(beatId, request, startedAt, phases, "failed", "ERROR", totalTokens, errorMessage, summary, null, snapshotVersionWritten);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  // ── Phase 1: Wake — load context + early-exit guards ─────────────
  private async executeWakePhase(
    request: BeatRequest,
    beatId: string,
    phases: BeatPhases,
  ): Promise<
    | { kind: "continue"; ctx: AgentBeatContext; snapshotVersionRead: number }
    | { kind: "skip"; snapshotVersionRead: number; status: BeatStatus; outcome: BeatOutcome; summary: string }
  > {
    const deps = this.deps!;
    const wakeStart = Date.now();

    deps.audit.auditAgent(
      request.companyId, request.role,
      "beat_started", `Beat ${beatId} started for ${request.role}`,
      { beatId }
    );
    deps.emitBeatEvent?.({ type: "beat_started", beatId, agentId: request.agentId, role: request.role });

    const snapshotVersionRead = deps.getSnapshotVersion();
    const ctx = await deps.loadAgentContext(
      request.agentId, beatId, this.beatCounter, request.trigger,
      { beatTokenBudget: this.config.beatTokenBudget, beatCostCeilingCents: this.config.beatCostCeilingCents }
    );

    const stamp = (): void => {
      phases.contextAssembly = { durationMs: Date.now() - wakeStart, tokensUsed: 0 };
    };

    if (!ctx) {
      stamp();
      return { kind: "skip", snapshotVersionRead, status: "skipped", outcome: "SKIPPED", summary: `Agent ${request.agentId} not found in snapshot` };
    }

    // Leadership roles (ceo, cto, pm) must always beat — they create sprints, assign tasks, plan work.
    // Only worker roles pause when no sprint exists.
    const isLeadership = ["ceo", "cto", "pm"].includes(request.role);

    if (this.config.pauseWhenNoActiveSprint && !ctx.currentSprint && !isLeadership) {
      stamp();
      return { kind: "skip", snapshotVersionRead, status: "skipped", outcome: "SKIPPED", summary: "No active sprint — paused" };
    }

    if (this.config.pauseWhenBudgetExhausted && ctx.companyBudgetRemainingCents <= 0) {
      stamp();
      return { kind: "skip", snapshotVersionRead, status: "skipped", outcome: "BUDGET_EXCEEDED", summary: "Company budget exhausted" };
    }

    stamp();
    return { kind: "continue", ctx, snapshotVersionRead };
  }

  // ── Phase 2: Observe — run checklist, decide idle/blocked/proceed ──
  private executeObservePhase(
    ctx: AgentBeatContext,
    request: BeatRequest,
    beatId: string,
    phases: BeatPhases,
  ):
    | { kind: "continue"; checklist: ChecklistResult }
    | { kind: "exit"; status: BeatStatus; outcome: BeatOutcome; summary: string }
  {
    const deps = this.deps!;
    const observeStart = Date.now();
    const checklist: ChecklistResult = runChecklist(ctx);

    phases.observation = {
      durationMs: Date.now() - observeStart,
      tokensUsed: 0,
      checkResults: checklist.results,
    };

    if (!checklist.hasActionNeeded && !checklist.hasBlocked) {
      const summary = `Idle beat for ${request.role} — all checks OK`;
      deps.audit.auditAgent(request.companyId, request.role, "beat_idle", summary, { beatId });
      deps.emitBeatEvent?.({ type: "beat_idle", beatId, agentId: request.agentId, role: request.role, data: { outcome: "HEARTBEAT_OK" } });
      return { kind: "exit", status: "completed", outcome: "HEARTBEAT_OK", summary };
    }

    if (checklist.hasBlocked && !checklist.hasActionNeeded) {
      const blockDetail = checklist.results.find((r) => r.status === "blocked");
      const summary = `Blocked: ${blockDetail?.detail ?? "unknown"}`;
      deps.audit.auditAgent(request.companyId, request.role, "beat_blocked", summary, { beatId });
      return { kind: "exit", status: "skipped", outcome: "SKIPPED", summary };
    }

    return { kind: "continue", checklist };
  }

  // ── Phase 3: Execute — task work or checklist action ───────────────
  private async executeActPhase(
    ctx: AgentBeatContext,
    request: BeatRequest,
    beatId: string,
    phases: BeatPhases,
    checklist: ChecklistResult,
  ): Promise<{ outcome: BeatOutcome; summary: string | null; tokens: number }> {
    const deps = this.deps!;
    const execStart = Date.now();
    let execTokens = 0;
    let execActions = 0;
    let execToolCalls = 0;
    let outcome: BeatOutcome = "WORK_DONE";
    let summary: string | null = null;

    if (!deps.executeTask) {
      summary = `[stub] Would execute: ${checklist.primaryAction?.suggestedAction ?? "unknown action"}`;
      phases.execution = { durationMs: Date.now() - execStart, tokensUsed: 0, toolCalls: 0, actionsCount: 0 };
      return { outcome, summary, tokens: 0 };
    }

    // Vision: orchestrator does NOT pick the task. We wake the agent and
    // let it claim a task (or run a checklist action) via its own tools.
    // The legacy `executeChecklistAction` path is preserved for non-task
    // work (e.g. CEO sprint creation) when the agent has no claimable
    // tasks AND the checklist surfaced a primary action.
    const hasClaimableTask = ctx.tasks.some(
      (t) =>
        (t.status === "in_progress" || t.status === "planned" || t.status === "created") &&
        (t.assignedRole === ctx.role || !t.assignedRole)
    );

    if (!hasClaimableTask && deps.executeChecklistAction && checklist.primaryAction) {
      // No task but checklist says action_needed — dispatch to role-specific handler
      deps.audit.auditAgent(
        request.companyId, request.role,
        "beat_checklist_action", `Checklist action: ${checklist.primaryAction.suggestedAction ?? "(none)"}`,
        { beatId, detail: { action: checklist.primaryAction } }
      );

      const actionResult = await deps.executeChecklistAction(
        ctx,
        { detail: checklist.primaryAction.detail ?? "", suggestedAction: checklist.primaryAction.suggestedAction ?? "" },
        beatId
      );
      execTokens = actionResult.tokensUsed;
      execActions = actionResult.actionsCount;
      execToolCalls = actionResult.toolCalls;
      summary = actionResult.summary;
    } else {
      deps.audit.auditAgent(
        request.companyId, request.role,
        "beat_executing", `Waking ${request.role} for beat`,
        { beatId, detail: { hasClaimableTask } }
      );

      const result = await deps.executeTask(ctx, beatId);
      execTokens = result.tokensUsed;
      execActions = result.actionsCount;
      execToolCalls = result.toolCalls;
      summary = result.summary;

      // P4.4: budget enforcement — mark if token budget exceeded
      if (execTokens > this.config.beatTokenBudget) {
        outcome = "BUDGET_EXCEEDED";
        summary = `${summary} [token budget exceeded: ${execTokens}/${this.config.beatTokenBudget}]`;
      }
    }

    phases.execution = {
      durationMs: Date.now() - execStart,
      tokensUsed: execTokens,
      toolCalls: execToolCalls,
      actionsCount: execActions,
    };

    return { outcome, summary, tokens: execTokens };
  }

  // ── Phase 4: Serialize — flush staged mutations + heartbeat marker ──
  private async executeSerializePhase(
    request: BeatRequest,
    beatId: string,
    phases: BeatPhases,
    snapshotVersionRead: number | null,
  ): Promise<{ snapshotVersionWritten: number; mutationCount: number }> {
    const deps = this.deps!;
    const serializeStart = Date.now();

    // Stage the heartbeat status mutation
    this.stageMutation({ type: "agent_status", agentId: request.agentId, status: "active" });

    // Flush all staged mutations atomically (beat work + heartbeat status)
    const heartbeatResult = await this.flushStagedMutations(
      request.companyId,
      { eventId: beatId, summary: `Beat ${beatId} serialize` },
      snapshotVersionRead ?? undefined
    );

    await deps.flushStore();

    phases.serialization = { durationMs: Date.now() - serializeStart, mutationCount: heartbeatResult.applied };

    return { snapshotVersionWritten: heartbeatResult.version, mutationCount: heartbeatResult.applied };
  }

  // ── Task selection ───────────────────────────────────────
  // Removed: orchestrator no longer pre-selects tasks for the agent.
  // Agents see their open tasks in the rendered state and call `task_claim`
  // themselves. See plans/agent-redesign/00-vision.md.

  // ── Build BeatRecord ─────────────────────────────────────

  private buildRecord(
    beatId: string, request: BeatRequest, startedAt: string,
    phases: BeatPhases, status: BeatStatus, outcome: BeatOutcome,
    totalTokens: number, errorMessage: string | null, summary: string | null,
    snapshotVersionRead: number | null, snapshotVersionWritten: number | null,
  ): BeatRecord {
    // Rough cost estimate: ~$0.001 per 1K tokens → 0.1¢ per 1K tokens
    const costCents = Math.ceil(totalTokens / 1000 * 0.1);
    return {
      id: beatId,
      companyId: request.companyId,
      agentId: request.agentId,
      beatNumber: this.beatCounter,
      trigger: request.trigger,
      startedAt,
      endedAt: new Date().toISOString(),
      status, snapshotVersionRead, snapshotVersionWritten, phases,
      outcome, totalTokens, costCents,
      errorMessage, summary,
    };
  }

  // ── Stub executor (fallback when no deps) ────────────────

  private async stubExecutor(request: BeatRequest, beatId: string): Promise<BeatRecord> {
    const now = new Date().toISOString();
    console.log(`[HEARTBEAT] Stub beat ${beatId} for ${request.role} (${request.agentId}) — would run`);
    return {
      id: beatId,
      companyId: request.companyId,
      agentId: request.agentId,
      beatNumber: this.beatCounter,
      trigger: request.trigger,
      startedAt: now, endedAt: now,
      status: "completed" as BeatStatus,
      snapshotVersionRead: 0, snapshotVersionWritten: null,
      phases: {},
      outcome: "HEARTBEAT_OK",
      totalTokens: 0, costCents: 0,
      errorMessage: null,
      summary: `Stub beat for ${request.role} — no deps provided`,
    };
  }
}
