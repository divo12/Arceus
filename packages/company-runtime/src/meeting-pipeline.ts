/**
 * MeetingPipeline — Spec 18 Phase 3+4
 *
 * Orchestrates the 5-step meeting pipeline:
 *   scheduled → collecting → synthesizing → resolving → learning → completed
 *
 * The "executing" status is folded into "resolving" since resolve+execute
 * happen together (resolution decisions include task actions).
 */

import type {
  CompanySnapshot,
  Meeting,
} from "@arceus/contracts";

// ── Dependencies ───────────────────────────────────────────

export interface MeetingPipelineDeps {
  /** Spec 31 Phase 7.C.b — async to read from canonical. */
  getSnapshot: () => Promise<CompanySnapshot>;
  /** Spec 31 Phase 7.C.d — async to write directly to canonical. */
  updateMeeting: (id: string, updater: (m: Meeting) => Meeting) => Promise<Meeting | null>;
  flush: () => Promise<void>;

  /** Phase 4: Trigger contribution collection from all participant agents. */
  collectContributions?: (meeting: Meeting) => Promise<Meeting>;

  /** Phase 4: Run LLM synthesis on the meeting contributions. */
  synthesizeMeeting?: (meeting: Meeting) => Promise<Meeting>;

  /** Phase 5: Resolve conflicts/blockers via CEO LLM call. Returns updated meeting with resolutions. */
  resolveMeeting?: (meeting: Meeting) => Promise<Meeting>;

  /** Phase 5: Execute resolution decisions (create/modify tasks, escalations). Returns counts. */
  executeMeetingDecisions?: (meeting: Meeting) => Promise<{ tasksCreated: number; tasksModified: number; escalationsCreated: number }>;

  /** Phase 5: Build daily sync brief and post summary card. Returns updated meeting with brief. */
  produceBrief?: (meeting: Meeting) => Promise<Meeting>;

  /** Phase 6: Extract memories from meeting for each participant. Returns count of memories stored. */
  extractMemories?: (meeting: Meeting) => Promise<number>;

  /** Phase 7: Called after an escalation meeting completes so the caller can re-escalate if unresolved. */
  /** Spec 31 Phase 7.C.c — async to read from canonical. */
  onEscalationComplete?: (meeting: Meeting) => Promise<void> | void;

  /** Phase 8: Start token accumulator for a meeting pipeline run. */
  startTokenTracking?: (meetingId: string) => void;

  /** Phase 8: Drain accumulated tokens for a meeting pipeline run. */
  drainTokens?: (meetingId: string) => number;
}

// ── Step Interfaces (stubs for now, real in Phases 4-6) ────

export interface CollectResult {
  contributionCount: number;
}

export interface SynthesizeResult {
  conflictCount: number;
  blockerCount: number;
}

export interface ResolveResult {
  decisionCount: number;
  tasksCreated: number;
  tasksModified: number;
  escalationsCreated: number;
}

export interface LearnResult {
  memoriesExtracted: number;
}

// ── Pipeline ───────────────────────────────────────────────

export class MeetingPipeline {
  private readonly deps: MeetingPipelineDeps;

  constructor(deps: MeetingPipelineDeps) {
    this.deps = deps;
  }

  /**
   * Run the full pipeline for a meeting. The meeting must exist with
   * status "scheduled". Transitions through each step sequentially.
   */
  async run(meetingId: string): Promise<void> {
    const startMs = Date.now();

    const meeting = await this.getMeeting(meetingId);
    if (!meeting) {
      console.warn(`[MEETING-PIPELINE] Meeting ${meetingId} not found`);
      return;
    }
    if (meeting.status !== "scheduled") {
      console.warn(`[MEETING-PIPELINE] Meeting ${meetingId} is ${meeting.status}, expected scheduled`);
      return;
    }

    console.log(`[MEETING-PIPELINE] Starting pipeline for ${meetingId} (${meeting.type})`);

    // Phase 8: Start token tracking for this pipeline run
    this.deps.startTokenTracking?.(meetingId);

    // Step 1: Collect contributions
    await this.transition(meetingId, "collecting");
    const collectResult = await this.collect(meetingId);

    // Step 2: Synthesize — identify conflicts, blockers, highlights
    await this.transition(meetingId, "synthesizing");
    const synthesizeResult = await this.synthesize(meetingId);

    // Step 3: Resolve — make decisions (skippable for daily_sync with no issues)
    const shouldSkipResolve = this.shouldSkipResolve(meeting, synthesizeResult);
    let resolveResult: ResolveResult = { decisionCount: 0, tasksCreated: 0, tasksModified: 0, escalationsCreated: 0 };
    if (!shouldSkipResolve) {
      await this.transition(meetingId, "resolving");
      resolveResult = await this.resolve(meetingId);
    } else {
      console.log(`[MEETING-PIPELINE] Skipping resolve for ${meetingId} (no conflicts/blockers)`);
    }

    // Step 4: Learn — extract memories
    await this.transition(meetingId, "learning");
    const learnResult = await this.learn(meetingId);

    // Step 4b: Produce daily sync brief (for daily_sync meetings)
    await this.produceBrief(meetingId);

    // Step 5: Complete
    const durationMs = Date.now() - startMs;
    const totalTokensUsed = this.deps.drainTokens?.(meetingId) ?? 0;

    // Phase 8: Look up skipCount from the meeting's schedule (meeting debt)
    const snap = await this.deps.getSnapshot();
    const schedule = meeting.scheduleId
      ? (snap.meetingSchedules ?? []).find((s) => s.id === meeting.scheduleId)
      : null;
    const skippedBefore = schedule?.skipCount ?? 0;

    await this.deps.updateMeeting(meetingId, (m) => ({
      ...m,
      status: "completed",
      completedAt: new Date().toISOString(),
      healthSnapshot: {
        meetingId: m.id,
        scheduleId: m.scheduleId,
        pipelineDurationMs: durationMs,
        contributionCount: collectResult.contributionCount,
        conflictCount: synthesizeResult.conflictCount,
        blockerCount: synthesizeResult.blockerCount,
        decisionsCount: resolveResult.decisionCount,
        tasksCreated: resolveResult.tasksCreated,
        tasksModified: resolveResult.tasksModified,
        escalationsCreated: resolveResult.escalationsCreated,
        totalTokensUsed,
        skippedBefore,
      },
    }));

    await this.deps.flush();

    console.log(
      `[MEETING-PIPELINE] Completed ${meetingId} in ${durationMs}ms ` +
      `(contributions=${collectResult.contributionCount}, conflicts=${synthesizeResult.conflictCount}, ` +
      `blockers=${synthesizeResult.blockerCount}, decisions=${resolveResult.decisionCount}, ` +
      `memories=${learnResult.memoriesExtracted}, tokens=${totalTokensUsed}, skippedBefore=${skippedBefore})`,
    );

    // Phase 7: Notify escalation handler so it can re-escalate if still unresolved
    const completedMeeting = await this.getMeeting(meetingId);
    if (completedMeeting?.type === "escalation" && this.deps.onEscalationComplete) {
      await this.deps.onEscalationComplete(completedMeeting);
    }
  }

  // ── Step Implementations ────────────────────────────────

  /** Collect contributions from all participant agents. */
  private async collect(meetingId: string): Promise<CollectResult> {
    const meeting = await this.getMeeting(meetingId);
    if (!meeting) return { contributionCount: 0 };

    if (this.deps.collectContributions) {
      const updated = await this.deps.collectContributions(meeting);
      return { contributionCount: updated.contributions.length };
    }

    // Fallback: count any contributions already on the meeting (from recordMeeting)
    return { contributionCount: meeting.contributions.length };
  }

  /** Synthesize contributions — detect conflicts, blockers, highlights. */
  private async synthesize(meetingId: string): Promise<SynthesizeResult> {
    const meeting = await this.getMeeting(meetingId);
    if (!meeting) return { conflictCount: 0, blockerCount: 0 };

    if (this.deps.synthesizeMeeting) {
      const updated = await this.deps.synthesizeMeeting(meeting);
      return {
        conflictCount: updated.synthesis?.conflicts.length ?? 0,
        blockerCount: updated.synthesis?.blockers.length ?? 0,
      };
    }

    return { conflictCount: 0, blockerCount: 0 };
  }

  /** Resolve conflicts and blockers — create task actions, escalations. */
  private async resolve(meetingId: string): Promise<ResolveResult> {
    const meeting = await this.getMeeting(meetingId);
    if (!meeting) return { decisionCount: 0, tasksCreated: 0, tasksModified: 0, escalationsCreated: 0 };

    // Step 1: LLM resolution decisions
    if (this.deps.resolveMeeting) {
      const resolved = await this.deps.resolveMeeting(meeting);
      const decisionCount = resolved.resolutions?.decisions.length ?? 0;

      // Step 2: Execute decisions (create tasks, escalations)
      if (this.deps.executeMeetingDecisions && decisionCount > 0) {
        const execResult = await this.deps.executeMeetingDecisions(resolved);
        return { decisionCount, ...execResult };
      }

      return { decisionCount, tasksCreated: 0, tasksModified: 0, escalationsCreated: 0 };
    }

    return { decisionCount: 0, tasksCreated: 0, tasksModified: 0, escalationsCreated: 0 };
  }

  /** Produce daily sync brief for daily_sync meetings. */
  private async produceBrief(meetingId: string): Promise<void> {
    const meeting = await this.getMeeting(meetingId);
    if (!meeting || meeting.type !== "daily_sync") return;
    if (!this.deps.produceBrief) return;

    await this.deps.produceBrief(meeting);
  }

  /** Learn — extract memories from meeting for hippocampus. */
  private async learn(meetingId: string): Promise<LearnResult> {
    const meeting = await this.getMeeting(meetingId);
    if (!meeting) return { memoriesExtracted: 0 };

    if (this.deps.extractMemories) {
      const count = await this.deps.extractMemories(meeting);
      return { memoriesExtracted: count };
    }

    return { memoriesExtracted: 0 };
  }

  // ── Helpers ────────────────────────────────────────────

  private async getMeeting(meetingId: string): Promise<Meeting | undefined> {
    const snap = await this.deps.getSnapshot();
    return snap.meetings.find((m) => m.id === meetingId);
  }

  private async transition(meetingId: string, status: Meeting["status"]): Promise<void> {
    await this.deps.updateMeeting(meetingId, (m) => ({ ...m, status }));
  }

  /**
   * Determine if the resolve step should be skipped.
   * Skip when: daily_sync type AND zero conflicts AND zero blockers.
   */
  private shouldSkipResolve(meeting: Meeting, synthesis: SynthesizeResult): boolean {
    if (meeting.type !== "daily_sync") return false;
    return synthesis.conflictCount === 0 && synthesis.blockerCount === 0;
  }
}
