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
  loadAgentContext: (
    agentId: string, beatId: string, beatNumber: number, trigger: BeatTrigger,
    config: { beatTokenBudget: number; beatCostCeilingCents: number }
  ) => AgentBeatContext | null;

  getSnapshotVersion: () => number;

  applyMutations: (
    companyId: string,
    mutations: Array<{ type: string; [key: string]: unknown }>,
    causation?: { eventId?: string; summary?: string },
    expectedVersion?: number
  ) => { version: number; applied: number; errors: string[] };

  commitBeatRecord: (record: BeatRecord) => Promise<boolean>;
  flushStore: () => Promise<void>;

  audit: {
    auditAgent: (companyId: string, agentRole: string, eventType: string, summary: string, opts?: Record<string, unknown>) => void;
    auditSystem: (companyId: string, eventType: string, summary: string, opts?: Record<string, unknown>) => void;
    auditError: (companyId: string, eventType: string, summary: string, error?: unknown, opts?: Record<string, unknown>) => void;
  };

  /** Execute specialist task work. Stub in Phase 2 — real execution in Phase 3. */
  executeTask?: (ctx: AgentBeatContext, taskId: string, beatId: string) => Promise<{
    summary: string; tokensUsed: number; actionsCount: number; toolCalls: number; completed: boolean;
  }>;

  /** Execute a checklist-driven action when no task is available (e.g. CEO proposes sprint). */
  executeChecklistAction?: (ctx: AgentBeatContext, action: { detail: string; suggestedAction: string }, beatId: string) => Promise<{
    summary: string; tokensUsed: number; actionsCount: number; toolCalls: number;
  }>;

  /** Return list of agents for the scheduler to iterate. */
  getAgentRoster?: () => Array<{ agentId: string; role: AgentIdentity["role"]; companyId: string }>;

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
  private readonly eventQueue = new Map<string, Array<{ companyId: string; role: AgentIdentity["role"]; event: BeatEventTrigger }>>();

  // ── Staged mutations (P4.3) ──────────────────────────────
  // Beats stage mutations during Phase 3 (Execute) and flush
  // them atomically in Phase 4 (Serialize).
  private stagedMutations: Array<{ type: string; [key: string]: unknown }> = [];

  /** Stage a mutation to be flushed at the end of the current beat. */
  stageMutation(mutation: { type: string; [key: string]: unknown }) {
    this.stagedMutations.push(mutation);
  }

  /** Flush all staged mutations via applyMutations, then clear. */
  private flushStagedMutations(
    companyId: string,
    causation: { eventId?: string; summary?: string },
    expectedVersion?: number,
  ): { version: number; applied: number; errors: string[] } {
    if (this.stagedMutations.length === 0 || !this.deps) {
      return { version: expectedVersion ?? 0, applied: 0, errors: [] };
    }
    const result = this.deps.applyMutations(companyId, this.stagedMutations, causation, expectedVersion);
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
    this.schedulerTimer = setInterval(() => this.tick(), this.config.schedulerIntervalMs);
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
      // Persist to DB (fire-and-forget — don't block the caller)
      if (this.deps) {
        this.deps.commitBeatRecord(record).catch(() => {});
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

    // Agent is idle — trigger immediately (fire-and-forget)
    this.triggerBeat({
      companyId, agentId, role,
      trigger: { type: "event", event },
    }).catch((err) => {
      console.error(`[HEARTBEAT] Reactive beat failed for ${role} (${event}):`, err instanceof Error ? err.message : err);
    });
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

    this.triggerBeat({
      companyId: next.companyId,
      agentId,
      role: next.role,
      trigger: { type: "event", event: next.event },
    }).catch((err) => {
      console.error(`[HEARTBEAT] Queued reactive beat failed for ${next.role} (${next.event}):`, err instanceof Error ? err.message : err);
    });
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

  // ── Scheduler tick ───────────────────────────────────────

  /** Role priority weights: lower = higher priority. */
  private static readonly ROLE_PRIORITY: Record<AgentIdentity["role"], number> = {
    ceo: 0, cto: 1, pm: 2, developer: 3, tester: 4, ui_designer: 5, marketing: 6, skills_lead: 7,
  };

  /**
   * Called every schedulerIntervalMs. Expires stale locks, then auto-dispatches
   * beats for agents whose role interval has elapsed, in priority order.
   */
  private tick(): void {
    const expired = this.locks.expireStale(this.config.beatTimeoutMs);
    if (expired.length > 0) {
      console.warn("[HEARTBEAT] Expired stale locks for agents:", expired.join(", "));
    }

    // Need agent roster to auto-schedule
    if (!this.deps?.getAgentRoster) return;

    const roster = this.deps.getAgentRoster();
    if (roster.length === 0) return;

    // Sort by role priority (CEO first)
    const sorted = [...roster].sort(
      (a, b) => (HeartbeatEngine.ROLE_PRIORITY[a.role] ?? 99) - (HeartbeatEngine.ROLE_PRIORITY[b.role] ?? 99)
    );

    const now = Date.now();
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

      // Fire and forget — triggerBeat handles lock + semaphore
      this.triggerBeat({
        companyId: agent.companyId,
        agentId: agent.agentId,
        role: agent.role,
        trigger: { type: "interval", scheduledAt: new Date(now).toISOString() },
      }).catch((err) => {
        console.error(`[HEARTBEAT] Auto-schedule beat failed for ${agent.role}:`, err instanceof Error ? err.message : err);
      });
    }
  }

  // ── 4-Phase Beat Executor ────────────────────────────────

  private async fourPhaseExecutor(request: BeatRequest, beatId: string): Promise<BeatRecord> {
    const deps = this.deps!;
    const startedAt = new Date().toISOString();
    const phases: BeatPhases = {};
    let totalTokens = 0;
    let outcome: BeatOutcome = "HEARTBEAT_OK";
    let status: BeatStatus = "completed";
    let errorMessage: string | null = null;
    let summary: string | null = null;
    let snapshotVersionRead: number | null = null;
    let snapshotVersionWritten: number | null = null;

    // Clear any leftover staged mutations from prior beat
    this.clearStagedMutations();

    let timedOut = false;
    const timeoutHandle = setTimeout(() => { timedOut = true; }, this.config.beatTimeoutMs);

    try {
      // ── Phase 1: Wake ──────────────────────────────────
      const wakeStart = Date.now();

      deps.audit.auditAgent(
        request.companyId, request.role,
        "beat_started", `Beat ${beatId} started for ${request.role}`,
        { beatId }
      );

      deps.emitBeatEvent?.({ type: "beat_started", beatId, agentId: request.agentId, role: request.role });

      snapshotVersionRead = deps.getSnapshotVersion();
      const ctx = deps.loadAgentContext(
        request.agentId, beatId, this.beatCounter, request.trigger,
        { beatTokenBudget: this.config.beatTokenBudget, beatCostCeilingCents: this.config.beatCostCeilingCents }
      );

      if (!ctx) {
        outcome = "SKIPPED";
        summary = `Agent ${request.agentId} not found in snapshot`;
        status = "skipped";
        phases.contextAssembly = { durationMs: Date.now() - wakeStart, tokensUsed: 0 };
        return this.buildRecord(beatId, request, startedAt, phases, status, outcome, totalTokens, errorMessage, summary, snapshotVersionRead, snapshotVersionWritten);
      }

      // Leadership roles (ceo, cto, pm) must always beat — they create sprints, assign tasks, plan work.
      // Only worker roles pause when no sprint exists.
      const leadershipRoles = ["ceo", "cto", "pm"];
      const isLeadership = leadershipRoles.includes(request.role);

      if (this.config.pauseWhenNoActiveSprint && !ctx.currentSprint && !isLeadership) {
        outcome = "SKIPPED";
        summary = "No active sprint — paused";
        status = "skipped";
        phases.contextAssembly = { durationMs: Date.now() - wakeStart, tokensUsed: 0 };
        return this.buildRecord(beatId, request, startedAt, phases, status, outcome, totalTokens, errorMessage, summary, snapshotVersionRead, snapshotVersionWritten);
      }

      if (this.config.pauseWhenBudgetExhausted && ctx.companyBudgetRemainingCents <= 0) {
        outcome = "BUDGET_EXCEEDED";
        summary = "Company budget exhausted";
        status = "skipped";
        phases.contextAssembly = { durationMs: Date.now() - wakeStart, tokensUsed: 0 };
        return this.buildRecord(beatId, request, startedAt, phases, status, outcome, totalTokens, errorMessage, summary, snapshotVersionRead, snapshotVersionWritten);
      }

      phases.contextAssembly = { durationMs: Date.now() - wakeStart, tokensUsed: 0 };

      // ── Phase 2: Observe ─────────────────────────────────
      if (timedOut) {
        return this.buildRecord(beatId, request, startedAt, phases, "timed_out", "TIMED_OUT", totalTokens, "Beat timed out in observe phase", null, snapshotVersionRead, snapshotVersionWritten);
      }

      const observeStart = Date.now();
      const checklist: ChecklistResult = runChecklist(ctx);

      phases.observation = {
        durationMs: Date.now() - observeStart,
        tokensUsed: 0,
        checkResults: checklist.results,
      };

      if (!checklist.hasActionNeeded && !checklist.hasBlocked) {
        outcome = "HEARTBEAT_OK";
        summary = `Idle beat for ${request.role} — all checks OK`;
        deps.audit.auditAgent(request.companyId, request.role, "beat_idle", summary, { beatId });
        deps.emitBeatEvent?.({ type: "beat_idle", beatId, agentId: request.agentId, role: request.role, data: { outcome } });
        return this.buildRecord(beatId, request, startedAt, phases, status, outcome, totalTokens, errorMessage, summary, snapshotVersionRead, snapshotVersionWritten);
      }

      if (checklist.hasBlocked && !checklist.hasActionNeeded) {
        outcome = "SKIPPED";
        const blockDetail = checklist.results.find((r) => r.status === "blocked");
        summary = `Blocked: ${blockDetail?.detail ?? "unknown"}`;
        status = "skipped";
        deps.audit.auditAgent(request.companyId, request.role, "beat_blocked", summary, { beatId });
        return this.buildRecord(beatId, request, startedAt, phases, status, outcome, totalTokens, errorMessage, summary, snapshotVersionRead, snapshotVersionWritten);
      }

      // ── Phase 3: Execute ─────────────────────────────────
      if (timedOut) {
        return this.buildRecord(beatId, request, startedAt, phases, "timed_out", "TIMED_OUT", totalTokens, "Beat timed out before execute phase", null, snapshotVersionRead, snapshotVersionWritten);
      }

      const execStart = Date.now();
      let execTokens = 0;
      let execActions = 0;
      let execToolCalls = 0;

      if (deps.executeTask) {
        const actionableTask = this.selectTask(ctx);
        if (actionableTask) {
          deps.audit.auditAgent(
            request.companyId, request.role,
            "beat_executing", `Executing task: ${actionableTask.title}`,
            { beatId, detail: { taskId: actionableTask.id } }
          );

          const result = await deps.executeTask(ctx, actionableTask.id, beatId);
          execTokens = result.tokensUsed;
          execActions = result.actionsCount;
          execToolCalls = result.toolCalls;
          totalTokens += execTokens;
          outcome = "WORK_DONE";
          summary = result.summary;

          // P4.4: budget enforcement — mark if token budget exceeded
          if (totalTokens > this.config.beatTokenBudget) {
            outcome = "BUDGET_EXCEEDED";
            summary = `${summary} [token budget exceeded: ${totalTokens}/${this.config.beatTokenBudget}]`;
          }
        } else if (deps.executeChecklistAction && checklist.primaryAction) {
          // No task but checklist says action_needed — dispatch to role-specific handler
          deps.audit.auditAgent(
            request.companyId, request.role,
            "beat_checklist_action", `Checklist action: ${checklist.primaryAction.suggestedAction}`,
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
          totalTokens += execTokens;
          outcome = "WORK_DONE";
          summary = actionResult.summary;
        } else {
          outcome = "WORK_DONE";
          summary = checklist.primaryAction?.suggestedAction ?? "Action needed but no specific task";
        }
      } else {
        outcome = "WORK_DONE";
        summary = `[stub] Would execute: ${checklist.primaryAction?.suggestedAction ?? "unknown action"}`;
      }

      phases.execution = {
        durationMs: Date.now() - execStart,
        tokensUsed: execTokens,
        toolCalls: execToolCalls,
        actionsCount: execActions,
      };

      // ── Phase 4: Serialize ───────────────────────────────
      if (timedOut) {
        return this.buildRecord(beatId, request, startedAt, phases, "timed_out", "TIMED_OUT", totalTokens, "Beat timed out before serialize phase", null, snapshotVersionRead, snapshotVersionWritten);
      }

      const serializeStart = Date.now();
      let mutationCount = 0;

      // Stage the heartbeat status mutation
      this.stageMutation({ type: "agent_status", agentId: request.agentId, status: "active" });

      // Flush all staged mutations atomically (beat work + heartbeat status)
      const heartbeatResult = this.flushStagedMutations(
        request.companyId,
        { eventId: beatId, summary: `Beat ${beatId} serialize` },
        snapshotVersionRead ?? undefined
      );

      mutationCount += heartbeatResult.applied;
      snapshotVersionWritten = heartbeatResult.version;

      await deps.flushStore();

      phases.serialization = { durationMs: Date.now() - serializeStart, mutationCount };

      deps.audit.auditAgent(
        request.companyId, request.role,
        "beat_completed",
        `Beat ${beatId} completed: ${outcome} — ${summary}`,
        { beatId, detail: { outcome, totalTokens, phases } }
      );

      deps.emitBeatEvent?.({ type: "beat_completed", beatId, agentId: request.agentId, role: request.role, data: { outcome, totalTokens, summary } });

      return this.buildRecord(beatId, request, startedAt, phases, status, outcome, totalTokens, errorMessage, summary, snapshotVersionRead, snapshotVersionWritten);

    } catch (err) {
      outcome = "ERROR";
      status = "failed";
      errorMessage = err instanceof Error ? err.message : String(err);
      summary = `Beat failed: ${errorMessage}`;
      this.clearStagedMutations();
      deps.audit.auditError(request.companyId, "beat_failed", summary, err, { beatId });
      deps.emitBeatEvent?.({ type: "beat_failed", beatId, agentId: request.agentId, role: request.role, data: { error: errorMessage } });
      return this.buildRecord(beatId, request, startedAt, phases, status, outcome, totalTokens, errorMessage, summary, snapshotVersionRead, snapshotVersionWritten);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  // ── Task selection ───────────────────────────────────────

  private selectTask(ctx: AgentBeatContext) {
    const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    const statusOrder = { in_progress: 0, planned: 1, created: 2 };
    type ActionableStatus = keyof typeof statusOrder;

    const actionable = ctx.tasks.filter(
      (t): t is typeof t & { status: ActionableStatus } =>
        t.status === "in_progress" || t.status === "planned" || t.status === "created"
    );
    if (actionable.length === 0) return null;

    actionable.sort((a, b) => {
      const sDiff = statusOrder[a.status] - statusOrder[b.status];
      if (sDiff !== 0) return sDiff;
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    });
    return actionable[0];
  }

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
