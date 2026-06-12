/**
 * MeetingScheduler — Spec 18 Phase 2 + Phase 7 (Escalation)
 *
 * Manages meeting schedule ticks. Each tick evaluates whether a
 * scheduled meeting (daily sync, etc.) is due and whether it should
 * be created or skipped based on snapshot conditions.
 *
 * Phase 7 adds escalation meetings: immediate 2-person meetings
 * triggered when an agent hits an unresolvable blocker. The
 * escalation chain follows the management hierarchy.
 *
 * The scheduler itself is a pure logic layer — it receives dependencies
 * from the API layer (store access, pipeline trigger) at construction.
 */

import type {
  AgentIdentity,
  CompanySnapshot,
  Meeting,
  MeetingSchedule,
  MeetingScheduleConfig,
} from "@arceus/contracts";
import { swallowAndAudit } from "./swallow.js";

// ── Dependencies ───────────────────────────────────────────

export interface MeetingSchedulerDeps {
  /** Spec 31 Phase 7.C.b — async to read from canonical. */
  getSnapshot: () => Promise<CompanySnapshot>;
  /** Spec 31 Phase 7.C.d — async to write directly to canonical. */
  upsertMeeting: (meeting: Meeting) => Promise<Meeting>;
  upsertMeetingSchedule: (schedule: MeetingSchedule) => Promise<MeetingSchedule>;
  updateMeetingSchedule: (id: string, updater: (s: MeetingSchedule) => MeetingSchedule) => Promise<MeetingSchedule | null>;
  /**
   * Audit C8 (F-361): atomic "fire a scheduled meeting" — creates the
   * meeting row AND advances the schedule's lastMeetingId / skipCount /
   * nextCheckAt in a single DB transaction. If the process dies mid-
   * write the whole pair rolls back, so the schedule never claims to
   * have fired a meeting that doesn't exist (and vice versa).
   *
   * Returns the persisted meeting, or `null` if the schedule row
   * disappeared between the snapshot read and the commit.
   */
  commitScheduledMeeting: (
    meeting: Meeting,
    scheduleId: string,
    scheduleUpdater: (s: MeetingSchedule) => MeetingSchedule,
  ) => Promise<Meeting | null>;
  /**
   * Spec 33 / Audit C1 Phase 4 — atomic "tick was a skip" record.
   * Single-statement UPDATE that increments `skipCount` and writes
   * the timestamps in one transaction. Replaces the previous read-
   * modify-write `updateMeetingSchedule` call so concurrent skips
   * can't lose increments.
   */
  recordScheduleSkip: (
    scheduleId: string,
    lastCheckedAt: Date,
    nextCheckAt: Date,
  ) => Promise<boolean>;
  flush: () => Promise<void>;
  runPipeline: (meetingId: string) => Promise<void>;
}

export interface MeetingSchedulerConfig {
  tickIntervalMs: number;
  defaultDailySyncIntervalMs: number;
}

// ── Scheduler ──────────────────────────────────────────────

export class MeetingScheduler {
  private readonly config: MeetingSchedulerConfig;
  private readonly deps: MeetingSchedulerDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private ticking = false;
  private lastTickErrorMsg: string | null = null;

  constructor(config: MeetingSchedulerConfig, deps: MeetingSchedulerDeps) {
    this.config = config;
    this.deps = deps;
  }

  // ── Lifecycle ──────────────────────────────────────────

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => void this.tick(), this.config.tickIntervalMs);
    console.log(`[MEETING-SCHEDULER] Started (tick every ${this.config.tickIntervalMs}ms)`);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log("[MEETING-SCHEDULER] Stopped");
  }

  isRunning(): boolean {
    return this.running;
  }

  // ── Tick ───────────────────────────────────────────────

  async tick(): Promise<void> {
    if (this.ticking) return; // guard re-entrant ticks
    this.ticking = true;
    try {
      const snap = await this.deps.getSnapshot();
      this.lastTickErrorMsg = null; // healthy tick — re-arm error logging
      // Spec 31 Phase 7.C.1 — empty company id signals "no company yet."
      if (!snap.company.id) return;

      // Auto-create daily sync schedule when 2+ agents exist
      await this.ensureDailySyncExists(snap);

      const now = Date.now();
      const schedules = snap.meetingSchedules ?? [];

      for (const schedule of schedules) {
        if (!schedule.enabled) continue;

        // Check if it's time
        const nextCheck = schedule.nextCheckAt ? new Date(schedule.nextCheckAt).getTime() : 0;
        if (now < nextCheck) continue;

        // ── One-per-sprint gate for daily_sync ───────────────
        // A daily_sync meeting should fire at most once per sprint. If
        // one has already been created for the current sprint (or if
        // there's no active sprint yet), advance the schedule clock
        // without incrementing skipCount and without firing.
        if (schedule.type === "daily_sync") {
          const sprintId = snap.company.currentSprintId;
          const sprint = sprintId ? snap.sprints.find((s) => s.id === sprintId) : null;
          const sprintStartMs = sprint?.startedAt ? new Date(sprint.startedAt).getTime() : null;
          const alreadyFiredThisSprint =
            sprintStartMs !== null &&
            snap.meetings.some(
              (m) =>
                m.type === "daily_sync" &&
                m.createdAt &&
                new Date(m.createdAt).getTime() >= sprintStartMs,
            );
          if (!sprintId || alreadyFiredThisSprint) {
            const nowIso = new Date().toISOString();
            const nextCheckIso = new Date(now + schedule.intervalMs).toISOString();
            await this.deps.updateMeetingSchedule(schedule.id, (s) => ({
              ...s,
              lastCheckedAt: nowIso,
              nextCheckAt: nextCheckIso,
            }));
            continue;
          }
        }

        const needsMeeting = this.assessMeetingNeed(snap, schedule);

        // Update schedule metadata
        const nowIso = new Date().toISOString();
        const nextCheckIso = new Date(now + schedule.intervalMs).toISOString();

        if (!needsMeeting) {
          // Spec 33 / Audit C1 Phase 4 — atomic "tick was a skip" UPDATE
          // (`skip_count = skip_count + 1` + timestamps in one statement).
          // Replaces the previous read-modify-write so 10 concurrent
          // skips on the same schedule can't lose any increments.
          await this.deps.recordScheduleSkip(
            schedule.id,
            new Date(nowIso),
            new Date(nextCheckIso),
          );
          console.log(`[MEETING-SCHEDULER] Skipped ${schedule.type} (skipCount=${schedule.skipCount + 1})`);
          continue;
        }

        // Audit C8 (F-361): meeting INSERT + schedule UPDATE commit
        // atomically. Previously two sequential awaits — a crash
        // between left the schedule pointing at a meeting that didn't
        // exist (or vice versa). Now both land or neither.
        const meeting = this.createScheduledMeeting(snap, schedule);
        const persisted = await this.deps.commitScheduledMeeting(
          meeting,
          schedule.id,
          (s) => ({
            ...s,
            lastCheckedAt: nowIso,
            lastMeetingId: meeting.id,
            nextCheckAt: nextCheckIso,
            skipCount: 0,
            totalRuns: s.totalRuns + 1,
          }),
        );
        if (!persisted) {
          console.warn(`[MEETING-SCHEDULER] Schedule ${schedule.id} vanished during commit — meeting not created`);
          continue;
        }

        console.log(`[MEETING-SCHEDULER] Created ${schedule.type} meeting ${meeting.id}`);

        // Audit C3.5 (F-283/F-360): meeting pipeline runs for minutes per
        // meeting. Routing through swallowAndAudit means a hung LLM or DB
        // failure surfaces to the error sink instead of becoming a console
        // line that gets buried in scheduler tick noise.
        swallowAndAudit("meeting_scheduler.tick_pipeline", () =>
          this.deps.runPipeline(meeting.id),
          { detail: { meetingId: meeting.id, type: schedule.type } },
        );
      }
    } catch (err) {
      // Dedupe consecutive identical errors. The active-company pointer can
      // go stale (e.g. the company was deleted out from under the global
      // scheduler), making getSnapshot throw "company … not found" on
      // EVERY 30s tick — a flood that buries real signal in the logs.
      // Log a transition once; stay quiet while the same error repeats.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== this.lastTickErrorMsg) {
        console.error("[MEETING-SCHEDULER] Tick error:", msg);
        this.lastTickErrorMsg = msg;
      }
    } finally {
      this.ticking = false;
    }
  }

  // ── Need Assessment ────────────────────────────────────

  /**
   * Determines whether a scheduled meeting should fire or be skipped.
   * Pure snapshot queries — no side effects.
   */
  assessMeetingNeed(snap: CompanySnapshot, schedule: MeetingSchedule): boolean {
    const cfg = schedule.config;

    // Never skip past max consecutive skips
    if (schedule.skipCount >= cfg.maxConsecutiveSkips) return true;

    // Only apply skip logic if conditional checking is enabled
    if (!schedule.conditionalCheckEnabled) return true;

    const hasBlockedTasks = snap.tasks.some(
      (t) => t.status === "blocked" && schedule.participantAgentIds.includes(t.assignedAgentId ?? ""),
    );

    // If there are blocked tasks, always meet
    if (hasBlockedTasks) return true;

    // Check for recent task changes since last check
    const lastChecked = schedule.lastCheckedAt ? new Date(schedule.lastCheckedAt).getTime() : 0;
    const hasTaskChanges = snap.tasks.some((t) => {
      // Task has no updatedAt — approximate with the latest known timestamp
      const lastTouched = t.completedAt ?? t.startedAt ?? t.createdAt;
      const updated = lastTouched ? new Date(lastTouched).getTime() : 0;
      return updated > lastChecked && schedule.participantAgentIds.includes(t.assignedAgentId ?? "");
    });

    if (cfg.skipIfNoBlockers && !hasBlockedTasks && cfg.skipIfNoTaskChanges && !hasTaskChanges) {
      return false;
    }

    return true;
  }

  // ── Daily Sync Auto-create ─────────────────────────────

  /**
   * Ensures a daily_sync schedule exists when 2+ agents are active.
   * Idempotent — safe to call every tick.
   */
  async ensureDailySyncExists(snap: CompanySnapshot): Promise<void> {
    const schedules = snap.meetingSchedules ?? [];
    const hasDailySync = schedules.some((s) => s.type === "daily_sync");
    if (hasDailySync) return;

    const activeAgents = snap.agents.filter((a) => a.status === "active" || a.status === "idle" || a.status === "running");
    if (activeAgents.length < 2) return;

    const ceo = activeAgents.find((a) => a.role === "ceo");
    const facilitatorId = ceo?.id ?? activeAgents[0].id;

    const schedule: MeetingSchedule = {
      id: `msched_daily_sync_${snap.company.id}`,
      companyId: snap.company.id,
      type: "daily_sync",
      title: "Daily sync",
      intervalMs: this.config.defaultDailySyncIntervalMs,
      participantAgentIds: activeAgents.map((a) => a.id),
      facilitatorAgentId: facilitatorId,
      conditionalCheckEnabled: true,
      enabled: true,
      lastCheckedAt: null,
      lastMeetingId: null,
      nextCheckAt: null, // triggers immediately on first tick
      skipCount: 0,
      totalRuns: 0,
      config: {
        maxConsecutiveSkips: 3,
        skipIfNoBlockers: true,
        skipIfNoTaskChanges: true,
        collectionTimeoutMs: 300_000,
      },
    };

    await this.deps.upsertMeetingSchedule(schedule);
    console.log(`[MEETING-SCHEDULER] Auto-created daily_sync schedule for ${activeAgents.length} agents`);
  }

  // ── Meeting Creation ───────────────────────────────────

  private createScheduledMeeting(snap: CompanySnapshot, schedule: MeetingSchedule): Meeting {
    return {
      id: `meeting_${crypto.randomUUID()}`,
      companyId: snap.company.id,
      scheduleId: schedule.id,
      type: schedule.type,
      title: schedule.title,
      status: "scheduled",
      facilitatorAgentId: schedule.facilitatorAgentId,
      participantAgentIds: schedule.participantAgentIds,
      contributions: [],
      synthesis: null,
      resolutions: null,
      brief: null,
      healthSnapshot: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
    };
  }

  // ── Escalation Meetings (Phase 7) ─────────────────────

  /**
   * Create an immediate 2-person escalation meeting between a blocked
   * agent and their direct manager. Returns the meeting (already
   * upserted) and fires the pipeline.
   *
   * Returns null if no manager exists for the role or if an active
   * escalation meeting already exists for this task.
   */
  async createEscalationMeeting(
    snap: CompanySnapshot,
    blockedAgentId: string,
    blockerDetail: string,
    relatedTaskId: string | null,
  ): Promise<Meeting | null> {
    const blockedAgent = snap.agents.find((a) => a.id === blockedAgentId);
    if (!blockedAgent) return null;

    const managerRole = getManagerRole(blockedAgent.role);
    if (!managerRole) return null; // CEO has no manager — would need board approval

    const managerAgent = snap.agents.find((a) => a.role === managerRole);
    if (!managerAgent) return null;

    // Guard: don't create duplicate escalation for the same task
    if (relatedTaskId) {
      const existing = snap.meetings.find(
        (m) =>
          m.type === "escalation" &&
          m.status !== "completed" &&
          m.title.includes(relatedTaskId),
      );
      if (existing) return null;
    }

    const now = new Date().toISOString();
    const meeting: Meeting = {
      id: `meeting_${crypto.randomUUID()}`,
      companyId: snap.company.id,
      scheduleId: null,
      type: "escalation",
      title: `Escalation: ${blockedAgent.name} → ${managerAgent.name} [${relatedTaskId ?? "general"}]`,
      status: "scheduled",
      facilitatorAgentId: managerAgent.id,
      participantAgentIds: [blockedAgentId, managerAgent.id],
      contributions: [],
      synthesis: null,
      resolutions: null,
      brief: null,
      healthSnapshot: null,
      createdAt: now,
      completedAt: null,
    };

    await this.deps.upsertMeeting(meeting);
    console.log(
      `[MEETING-SCHEDULER] Escalation meeting ${meeting.id}: ${blockedAgent.role} → ${managerRole} (${blockerDetail.slice(0, 80)})`,
    );

    // Fire pipeline immediately (async). Audit-routed.
    swallowAndAudit("meeting_scheduler.escalation_pipeline", () =>
      this.deps.runPipeline(meeting.id),
      { detail: { meetingId: meeting.id, blockedRole: blockedAgent.role, managerRole, kind: "escalation" } },
    );

    return meeting;
  }

  /**
   * Escalate an existing escalation meeting up the management chain.
   * Creates a new meeting with the next-level manager.
   *
   * Returns null if the chain is exhausted (already at CEO level).
   */
  async escalateUp(
    snap: CompanySnapshot,
    previousMeeting: Meeting,
    blockerDetail: string,
    relatedTaskId: string | null,
  ): Promise<Meeting | null> {
    // The facilitator of the previous meeting is the manager who couldn't resolve.
    // Escalate to THEIR manager.
    const prevManager = snap.agents.find((a) => a.id === previousMeeting.facilitatorAgentId);
    if (!prevManager) return null;

    const nextManagerRole = getManagerRole(prevManager.role);
    if (!nextManagerRole) return null; // Already at the top

    const nextManager = snap.agents.find((a) => a.role === nextManagerRole);
    if (!nextManager) return null;

    // The blocked agent is the non-facilitator participant
    const blockedAgentId = previousMeeting.participantAgentIds.find(
      (id) => id !== previousMeeting.facilitatorAgentId,
    );
    if (!blockedAgentId) return null;

    const now = new Date().toISOString();
    const meeting: Meeting = {
      id: `meeting_${crypto.randomUUID()}`,
      companyId: snap.company.id,
      scheduleId: null,
      type: "escalation",
      title: `Escalation: ${prevManager.name} → ${nextManager.name} [${relatedTaskId ?? "general"}]`,
      status: "scheduled",
      facilitatorAgentId: nextManager.id,
      participantAgentIds: [blockedAgentId, nextManager.id],
      contributions: [],
      synthesis: null,
      resolutions: null,
      brief: null,
      healthSnapshot: null,
      createdAt: now,
      completedAt: null,
    };

    await this.deps.upsertMeeting(meeting);
    console.log(
      `[MEETING-SCHEDULER] Escalation UP ${meeting.id}: ${prevManager.role} → ${nextManagerRole}`,
    );

    swallowAndAudit("meeting_scheduler.escalation_up_pipeline", () =>
      this.deps.runPipeline(meeting.id),
      { detail: { meetingId: meeting.id, prevRole: prevManager.role, nextRole: nextManagerRole, kind: "escalation_up" } },
    );

    return meeting;
  }
}

// ── Role Hierarchy (Escalation Chain) ──────────────────────

/**
 * Maps each role to its direct manager. Derived from ROLE_SOULS.allowedDirectReports.
 * CEO has no manager (returns null → triggers board approval instead).
 */
const MANAGER_ROLE_MAP: Record<AgentIdentity["role"], AgentIdentity["role"] | null> = {
  ceo: null,
  cto: "ceo",
  marketing: "ceo",
  pm: "cto",
  developer: "cto",
  tester: "cto",
  ui_designer: "cto",
  skills_lead: "cto",
};

/** Get the direct manager role for a given role. Returns null for CEO. */
export function getManagerRole(role: AgentIdentity["role"]): AgentIdentity["role"] | null {
  return MANAGER_ROLE_MAP[role] ?? null;
}

/** Build the full escalation chain for a role (excluding the role itself). */
export function getEscalationChain(role: AgentIdentity["role"]): AgentIdentity["role"][] {
  const chain: AgentIdentity["role"][] = [];
  let current = getManagerRole(role);
  while (current) {
    chain.push(current);
    current = getManagerRole(current);
  }
  return chain;
}
